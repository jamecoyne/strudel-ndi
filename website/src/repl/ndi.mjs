/*
ndi.mjs - NDI output for the desktop (Tauri) app.

Two feeds are rendered into offscreen canvases and posted to the Rust backend as raw RGBA frames:
- "text": the code editor, redrawn from the editor's DOM (text, syntax colors, highlights, cursor)
- "visuals": the drawing canvases (pianoroll, scope, spiral, hydra...) and inline widgets

The webview cannot be captured directly, so both feeds are composed here.
*/

import { persistentAtom } from '@nanostores/persistent';
import { atom } from 'nanostores';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../tauri.mjs';
import { settingsMap } from '../settings.mjs';

// both feeds are always sent in this size
export const NDI_WIDTH = 1024;
export const NDI_HEIGHT = 768;

export const defaultNdiSettings = {
  // framing, shared by both feeds
  framing: 'contain', // contain (whole editor) | width | window
  windowFit: 'contain', // with framing 'window': stretch | contain | cover
  // feeds
  textEnabled: false,
  visualsEnabled: false,
  textName: 'Strudel Text',
  visualsName: 'Strudel Visuals',
  textFps: 15,
  visualsFps: 30,
  textTransparent: false,
  visualsTransparent: false,
  visualsWidgets: true,
  // network
  groups: '',
  configSource: 'app', // app | system
  machineName: '',
  discoveryServers: '',
  extraIps: '',
  adapters: '',
  multicast: false,
  multicastPrefix: '239.255.0.0',
  multicastMask: '255.255.0.0',
  multicastTtl: 1,
};

export const $ndiSettings = persistentAtom('strudel-ndi-settings', defaultNdiSettings, {
  encode: JSON.stringify,
  decode: (value) => {
    try {
      return { ...defaultNdiSettings, ...JSON.parse(value) };
    } catch (err) {
      return defaultNdiSettings;
    }
  },
});

export const setNdiSetting = (key, value) => $ndiSettings.set({ ...$ndiSettings.get(), [key]: value });
export const resetNdiSettings = () => $ndiSettings.set(defaultNdiSettings);

// what the capture loop is doing, for the debug view
export const $ndiCapture = atom({ text: null, visuals: null, configureError: null });

const feedIds = ['text', 'visuals'];
const feeds = {};
let started = false;

function getFeed(id) {
  if (!feeds[id]) {
    const canvas = document.createElement('canvas');
    feeds[id] = {
      canvas,
      ctx: canvas.getContext('2d', { willReadFrequently: true }),
      busy: false,
      lastTime: 0,
      // when the last frame went to the backend
      lastSent: 0,
      // receivers connected to the feed. unknown until the first frame was sent
      connections: null,
      // the page changed since the last frame (only tracked for the text feed)
      dirty: true,
      // a sparse sample of the last frame that was sent, to detect unchanged frames
      lastSample: null,
      state: 'live',
      rendered: 0,
      dropped: 0,
      renderMs: 0,
      sendMs: 0,
      error: null,
    };
  }
  return feeds[id];
}

/* ...........................................................
                      network settings
............................................................*/

// the keys the backend cares about. changes to anything else (fps, resolution...) need no reconfigure
const backendKeys = [
  'textEnabled',
  'visualsEnabled',
  'textName',
  'visualsName',
  'groups',
  'configSource',
  'machineName',
  'discoveryServers',
  'extraIps',
  'adapters',
  'multicast',
  'multicastPrefix',
  'multicastMask',
  'multicastTtl',
];

function backendSettings(settings) {
  const picked = Object.fromEntries(backendKeys.map((key) => [key, settings[key]]));
  picked.multicastTtl = Math.max(0, Math.min(255, parseInt(picked.multicastTtl) || 0));
  return picked;
}

let configureTimeout;
let lastConfigured;
// true while the backend has the feeds of the current settings running
let configured = false;

export async function configureNdi(force = false) {
  if (!isTauri()) {
    return;
  }
  const settings = backendSettings($ndiSettings.get());
  lastConfigured = JSON.stringify(settings);
  configured = false;
  try {
    await invoke('ndi_configure', { settings, force });
    for (const id of feedIds) {
      if (feeds[id]) {
        // the feeds may have been restarted: find out again who is receiving
        feeds[id].connections = null;
        feeds[id].lastSent = 0;
      }
    }
    configured = true;
    $ndiCapture.set({ ...$ndiCapture.get(), configureError: null });
  } catch (err) {
    console.error('[ndi]', err);
    $ndiCapture.set({ ...$ndiCapture.get(), configureError: `${err}` });
  }
}

function scheduleConfigure() {
  if (JSON.stringify(backendSettings($ndiSettings.get())) === lastConfigured) {
    return;
  }
  // debounced, because names and addresses are typed letter by letter
  clearTimeout(configureTimeout);
  configured = false;
  configureTimeout = setTimeout(() => configureNdi(), 700);
}

export const getNdiStatus = () => invoke('ndi_status');
export const findNdiSources = (timeoutMs = 3000) => invoke('ndi_find_sources', { timeoutMs });

// the NDI runtime reads its network config only once, so changed network settings need an app restart
export function restartAppForNdi() {
  // keep the code that is in the editor, even if it was not evaluated yet
  const code = window.strudelMirror?.code;
  if (code) {
    settingsMap.setKey('latestCode', code);
  }
  return invoke('ndi_restart_app');
}

/* ...........................................................
                         text feed
............................................................*/

// How the page is mapped to a frame: frame = page * scale + (x, y).
// Both feeds use the same mapping, so code and drawings line up when the feeds are layered,
// whatever the size of the window.
function getFrameMapping(width, height, settings) {
  const editor = getMainEditor();
  const scroller = editor?.querySelector('.cm-scroller') || editor;
  const view = scroller?.getBoundingClientRect();
  if (settings.framing === 'window' || !view || view.width <= 0 || view.height <= 0) {
    // the whole window
    const viewWidth = window.innerWidth || 1;
    const viewHeight = window.innerHeight || 1;
    let scaleX = width / viewWidth;
    let scaleY = height / viewHeight;
    if (settings.windowFit === 'contain') {
      scaleX = scaleY = Math.min(scaleX, scaleY);
    } else if (settings.windowFit === 'cover') {
      scaleX = scaleY = Math.max(scaleX, scaleY);
    }
    return { scaleX, scaleY, x: (width - viewWidth * scaleX) / 2, y: (height - viewHeight * scaleY) / 2 };
  }
  if (settings.framing === 'width') {
    // larger text: fill the frame width and show the part of the editor around the cursor
    const scale = width / view.width;
    const visibleHeight = height / scale;
    let top = view.top;
    const cursor = editor.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
    if (cursor && cursor.height > 0) {
      top = cursor.top + cursor.height / 2 - visibleHeight / 2;
    }
    top = Math.max(view.top, Math.min(top, view.bottom - visibleHeight));
    return { scaleX: scale, scaleY: scale, x: -view.left * scale, y: -top * scale };
  }
  // the whole visible editor, justified to the top left
  const scale = Math.min(width / view.width, height / view.height);
  return { scaleX: scale, scaleY: scale, x: -view.left * scale, y: -view.top * scale };
}

const transparentColor = /^(transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/;
const isVisibleColor = (color) => !!color && !transparentColor.test(color);

function getBackgroundColor() {
  const root = getComputedStyle(document.documentElement);
  const fromTheme = root.getPropertyValue('--background').trim();
  if (fromTheme) {
    return fromTheme;
  }
  const body = getComputedStyle(document.body).backgroundColor;
  return isVisibleColor(body) ? body : '#222';
}

function getMainEditor() {
  // the repl's editor, not the prebake editor of the settings
  return window.strudelMirror?.editor?.dom || document.querySelector('.cm-editor');
}

const range = typeof document !== 'undefined' ? document.createRange() : null;

// draws the characters [start, end) of a text node at the place the browser laid them out
function drawTextRun(ctx, node, text, start, end) {
  range.setStart(node, start);
  range.setEnd(node, end);
  const rects = range.getClientRects();
  if (rects.length === 0) {
    return;
  }
  if (rects.length === 1 || end - start <= 1) {
    const rect = rects[0];
    if (rect.width > 0) {
      ctx.fillText(text.slice(start, end), rect.left, rect.top + rect.height / 2);
    }
    return;
  }
  // the run is broken over several lines: split it until each part sits on one line
  const middle = start + Math.floor((end - start) / 2);
  drawTextRun(ctx, node, text, start, middle);
  drawTextRun(ctx, node, text, middle, end);
}

function drawTextNode(ctx, node, style) {
  const text = node.nodeValue;
  if (!text || !text.trim()) {
    return;
  }
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (ctx.font !== font) {
    ctx.font = font;
  }
  ctx.fillStyle = style.color;
  // tabs are laid out by the browser, so draw the pieces between them separately
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\t', start);
    end = end === -1 ? text.length : end;
    if (end > start) {
      drawTextRun(ctx, node, text, start, end);
    }
    start = end + 1;
  }
}

function drawElementBox(ctx, el, style, view, options) {
  const background = style.backgroundColor;
  const hasBackground = isVisibleColor(background);
  const outlineWidth = style.outlineStyle !== 'none' ? parseFloat(style.outlineWidth) || 0 : 0;
  const borderLeft = style.borderLeftStyle !== 'none' ? parseFloat(style.borderLeftWidth) || 0 : 0;
  if (!hasBackground && !outlineWidth && !borderLeft) {
    return;
  }
  const rects = style.display === 'inline' ? el.getClientRects() : [el.getBoundingClientRect()];
  for (const rect of rects) {
    if (rect.width <= 0 && rect.height <= 0) {
      continue;
    }
    if (hasBackground) {
      // with a transparent feed, leave out the large theme backgrounds (editor, gutter) and keep highlights
      const isBackdrop = rect.width * rect.height > view.width * view.height * 0.25 || rect.height >= view.height;
      if (!(options.transparent && isBackdrop)) {
        ctx.fillStyle = background;
        ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
      }
    }
    if (outlineWidth) {
      ctx.strokeStyle = style.outlineColor;
      ctx.lineWidth = outlineWidth;
      const offset = outlineWidth / 2;
      ctx.strokeRect(rect.left - offset, rect.top - offset, rect.width + outlineWidth, rect.height + outlineWidth);
    }
    if (borderLeft) {
      // the cursor is an empty element with a left border
      ctx.fillStyle = style.borderLeftColor;
      ctx.fillRect(rect.left, rect.top, borderLeft, rect.height);
    }
  }
}

function drawElement(ctx, el, view, options) {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return;
  }
  if (style.display !== 'inline' && style.display !== 'contents') {
    const rect = el.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    const isOutside =
      rect.bottom < view.top || rect.top > view.bottom || rect.right < view.left || rect.left > view.right;
    if (hasSize && isOutside) {
      return;
    }
  }
  drawElementBox(ctx, el, style, view, options);
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      drawTextNode(ctx, child, style);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') {
        // inline widgets belong to the visuals feed
        continue;
      }
      drawElement(ctx, child, view, options);
    }
  }
}

function renderText(ctx, width, height, settings) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const transparent = !!settings.textTransparent;
  if (!transparent) {
    ctx.fillStyle = getBackgroundColor();
    ctx.fillRect(0, 0, width, height);
  }
  const editor = getMainEditor();
  if (!editor) {
    return;
  }
  const scroller = editor.querySelector('.cm-scroller') || editor;
  const view = scroller.getBoundingClientRect();
  if (view.width <= 0 || view.height <= 0) {
    return;
  }
  // everything below is drawn in page coordinates
  const mapping = getFrameMapping(width, height, settings);
  ctx.save();
  ctx.setTransform(mapping.scaleX, 0, 0, mapping.scaleY, mapping.x, mapping.y);
  ctx.beginPath();
  ctx.rect(view.left, view.top, view.width, view.height);
  ctx.clip();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '';
  drawElement(ctx, editor, view, { transparent });
  ctx.restore();
}

/* ...........................................................
                        visuals feed
............................................................*/

// The frame shows the window: every drawing sits where it is on screen, so inline widgets
// move with the editor when it is scrolled and line up with the text feed's code.
function renderVisuals(ctx, width, height, settings) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!settings.visualsTransparent) {
    ctx.fillStyle = getBackgroundColor();
    ctx.fillRect(0, 0, width, height);
  }
  // Same framing as the text feed: everything is drawn in page coordinates, so the drawings
  // stay under their code in any window size.
  const mapping = getFrameMapping(width, height, settings);
  ctx.save();
  ctx.setTransform(mapping.scaleX, 0, 0, mapping.scaleY, mapping.x, mapping.y);

  const editor = getMainEditor();
  const fullscreen = [];
  const widgets = [];
  for (const canvas of document.querySelectorAll('canvas')) {
    if (!canvas.width || !canvas.height || !canvas.isConnected) {
      continue;
    }
    if (editor?.contains(canvas)) {
      widgets.push(canvas);
      continue;
    }
    const style = getComputedStyle(canvas);
    // the drawing canvases (pianoroll, scope, hydra...) are fixed behind the editor
    if (style.position === 'fixed' && style.display !== 'none' && style.visibility !== 'hidden') {
      fullscreen.push(canvas);
    }
  }
  const drawInPlace = (canvas) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    try {
      ctx.drawImage(canvas, rect.left, rect.top, rect.width, rect.height);
    } catch (err) {
      // a canvas that cannot be read (e.g. tainted) is skipped
    }
  };
  fullscreen.forEach(drawInPlace);
  if (settings.visualsWidgets && widgets.length) {
    // inline widgets (._pianoroll(), ._scope()...) are cut off where the editor cuts them off
    const scroller = editor.querySelector('.cm-scroller') || editor;
    const view = scroller.getBoundingClientRect();
    ctx.beginPath();
    ctx.rect(view.left, view.top, view.width, view.height);
    ctx.clip();
    widgets.forEach(drawInPlace);
  }
  ctx.restore();
}

/* ...........................................................
                        capture loop
............................................................*/

const renderers = { text: renderText, visuals: renderVisuals };

// Capturing is the expensive part of NDI output: every frame is drawn, read back (3MB) and copied
// to the backend. So frames are only produced at the full rate while somebody is receiving and
// the picture changes. Otherwise a frame goes out once per IDLE_INTERVAL, which also tells us
// when a receiver connects.
const IDLE_INTERVAL = 1000;
const SAMPLE_STEP = 31; // compare every 31st pixel. not a divisor of the width, so the samples are spread out

function markDirty() {
  for (const id of feedIds) {
    if (feeds[id]) {
      feeds[id].dirty = true;
    }
  }
}

let observedEditor;
let editorObserver;
// redraw the text feed only when the editor changed: typing, highlights, cursor, widgets
function observeEditor() {
  const editor = getMainEditor();
  if (!editor || editor === observedEditor) {
    return;
  }
  editorObserver?.disconnect();
  editorObserver = new MutationObserver(markDirty);
  editorObserver.observe(editor, { subtree: true, childList: true, attributes: true, characterData: true });
  observedEditor = editor;
  markDirty();
}

// true if the frame differs from the last one that was sent
function hasChanged(feed, pixels) {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2);
  const count = Math.ceil(words.length / SAMPLE_STEP);
  let sample = feed.lastSample;
  let changed = false;
  if (!sample || sample.length !== count) {
    sample = feed.lastSample = new Uint32Array(count);
    changed = true;
  }
  for (let i = 0, j = 0; i < words.length; i += SAMPLE_STEP, j++) {
    if (sample[j] !== words[i]) {
      sample[j] = words[i];
      changed = true;
    }
  }
  return changed;
}

// Drawings can change at any time without telling anybody. Drawing and reading back a full frame
// just to find out that nothing moved is most of the cost of an idle feed, so look at a small
// version of the frame first.
const PROBE_SCALE = 4;
function visualsChanged(feed, settings) {
  if (!feed.probe) {
    feed.probe = document.createElement('canvas');
    feed.probeCtx = feed.probe.getContext('2d', { willReadFrequently: true });
  }
  const width = Math.round(NDI_WIDTH / PROBE_SCALE);
  const height = Math.round(NDI_HEIGHT / PROBE_SCALE);
  if (feed.probe.width !== width || feed.probe.height !== height) {
    feed.probe.width = width;
    feed.probe.height = height;
    feed.probeSample = null;
  }
  let pixels;
  try {
    renderVisuals(feed.probeCtx, width, height, settings);
    pixels = feed.probeCtx.getImageData(0, 0, width, height).data;
  } catch (err) {
    return true;
  }
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2);
  const last = feed.probeSample;
  let changed = !last || last.length !== words.length;
  if (!changed) {
    for (let i = 0; i < words.length; i++) {
      if (last[i] !== words[i]) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    feed.probeSample = words.slice();
  }
  return changed;
}

function captureFeed(id, settings, now) {
  const feed = getFeed(id);
  const fps = Math.max(1, Math.min(60, Number(settings[`${id}Fps`]) || 30));
  // small tolerance, so a 30fps feed is not halved by frames that arrive a hair early
  if (now - feed.lastTime < 1000 / fps - 2) {
    return;
  }
  const idleFrameDue = now - feed.lastSent >= IDLE_INTERVAL;
  if (feed.connections === 0 && !idleFrameDue) {
    feed.state = 'no receivers';
    return;
  }
  if (id === 'text') {
    observeEditor();
    if (!feed.dirty && !idleFrameDue) {
      feed.state = 'unchanged';
      return;
    }
  }
  if (feed.busy) {
    // the previous frame is still on its way to the backend
    feed.dropped++;
    return;
  }
  feed.lastTime = now;
  feed.dirty = false;
  if (id === 'visuals' && !visualsChanged(feed, settings) && !idleFrameDue) {
    feed.state = 'unchanged';
    return;
  }
  const width = NDI_WIDTH;
  const height = NDI_HEIGHT;
  if (feed.canvas.width !== width || feed.canvas.height !== height) {
    feed.canvas.width = width;
    feed.canvas.height = height;
    feed.lastSample = null;
  }
  const renderStart = performance.now();
  let pixels;
  try {
    renderers[id](feed.ctx, width, height, settings);
    pixels = feed.ctx.getImageData(0, 0, width, height).data;
  } catch (err) {
    feed.error = `${err}`;
    return;
  }
  feed.renderMs = performance.now() - renderStart;
  if (!hasChanged(feed, pixels) && !idleFrameDue) {
    // receivers keep showing the last frame, so an identical one does not need to be sent
    feed.state = 'unchanged';
    return;
  }
  feed.state = feed.connections === 0 ? 'no receivers' : 'live';
  feed.busy = true;
  feed.lastSent = now;
  const sendStart = performance.now();
  invoke('ndi_send_frame', new Uint8Array(pixels.buffer), {
    headers: { 'x-feed': id, 'x-width': `${width}`, 'x-height': `${height}`, 'x-fps': `${fps}` },
  })
    .then((connections) => {
      feed.connections = connections;
      feed.rendered++;
      feed.error = null;
    })
    .catch((err) => {
      feed.error = `${err}`;
    })
    .finally(() => {
      feed.sendMs = performance.now() - sendStart;
      feed.busy = false;
    });
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!configured) {
    return;
  }
  const settings = $ndiSettings.get();
  for (const id of feedIds) {
    if (settings[`${id}Enabled`]) {
      captureFeed(id, settings, now);
    }
  }
}

function publishCaptureStats() {
  const settings = $ndiSettings.get();
  const stats = { ...$ndiCapture.get() };
  for (const id of feedIds) {
    const feed = feeds[id];
    if (!feed || !settings[`${id}Enabled`]) {
      stats[id] = null;
      continue;
    }
    stats[id] = {
      fps: feed.rendered - (feed.lastRendered ?? 0),
      dropped: feed.dropped - (feed.lastDropped ?? 0),
      state: feed.state,
      renderMs: feed.renderMs,
      sendMs: feed.sendMs,
      width: feed.canvas.width,
      height: feed.canvas.height,
      error: feed.error,
    };
    feed.lastRendered = feed.rendered;
    feed.lastDropped = feed.dropped;
  }
  $ndiCapture.set(stats);
}

// starts NDI output. does nothing outside of the desktop app
export function initNdi() {
  if (started || typeof window === 'undefined' || !isTauri()) {
    return;
  }
  started = true;
  configureNdi();
  $ndiSettings.listen(() => {
    markDirty();
    scheduleConfigure();
  });
  // scrolling and resizing move the code without changing the editor's DOM
  document.addEventListener('scroll', markDirty, { capture: true, passive: true });
  window.addEventListener('resize', markDirty);
  requestAnimationFrame(tick);
  setInterval(publishCaptureStats, 1000);
}
