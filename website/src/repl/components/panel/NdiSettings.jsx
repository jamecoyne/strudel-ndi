import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import cx from '@src/cx.mjs';
import { ActionButton } from '../button/action-button.jsx';
import {
  $ndiSettings,
  $ndiCapture,
  setNdiSetting,
  resetNdiSettings,
  configureNdi,
  getNdiStatus,
  findNdiSources,
  restartAppForNdi,
  NDI_WIDTH,
  NDI_HEIGHT,
} from '../../ndi.mjs';

const inputClass =
  'bg-background text-xs h-8 max-h-8 border border-box rounded-0 text-foreground border-muted placeholder-muted focus:outline-none focus:ring-0 focus:border-foreground';

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-bold border-b border-muted pb-1">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="grid gap-1 text-xs">
      {label && <label className="text-sm">{label}</label>}
      {children}
      {hint && <span className="opacity-60">{hint}</span>}
    </div>
  );
}

function Text({ settingKey, placeholder, disabled }) {
  const settings = useStore($ndiSettings);
  return (
    <input
      className={cx('px-2', inputClass, disabled && 'opacity-50')}
      value={settings[settingKey] ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setNdiSetting(settingKey, e.target.value)}
    />
  );
}

function Check({ settingKey, label, disabled }) {
  const settings = useStore($ndiSettings);
  return (
    <label className={cx('text-xs', disabled && 'opacity-50')}>
      <input
        className="bg-background text-sm border border-muted focus:outline-none focus:ring-0 focus:border-foreground"
        type="checkbox"
        disabled={disabled}
        checked={!!settings[settingKey]}
        onChange={(e) => setNdiSetting(settingKey, e.target.checked)}
      />
      {' ' + label}
    </label>
  );
}

function Select({ settingKey, options, numeric }) {
  const settings = useStore($ndiSettings);
  return (
    <select
      className={cx('p-2', inputClass)}
      value={settings[settingKey]}
      onChange={(e) => setNdiSetting(settingKey, numeric ? Number(e.target.value) : e.target.value)}
    >
      {Object.entries(options).map(([value, label]) => (
        <option key={value} className="bg-background" value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

const fpsOptions = { 5: '5 fps', 10: '10 fps', 15: '15 fps', 24: '24 fps', 25: '25 fps', 30: '30 fps', 60: '60 fps' };

function FeedSettings({ id, title, description, children }) {
  return (
    <div className="space-y-2 border border-muted p-3">
      <Check settingKey={`${id}Enabled`} label={`Send ${title}`} />
      <div className="text-xs opacity-60">{description}</div>
      <Field label="Source name">
        <Text settingKey={`${id}Name`} placeholder={`Strudel ${title}`} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Resolution">
          <div className="h-8 flex items-center">
            {NDI_WIDTH} x {NDI_HEIGHT}
          </div>
        </Field>
        <Field label="Frame rate">
          <Select settingKey={`${id}Fps`} options={fpsOptions} numeric />
        </Field>
      </div>
      {children}
    </div>
  );
}

function splitList(value) {
  return `${value ?? ''}`
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function AdapterPicker({ interfaces, disabled }) {
  const { adapters } = useStore($ndiSettings);
  const selected = splitList(adapters);
  const usable = (interfaces ?? []).filter((i) => !i.isLoopback);
  if (!usable.length) {
    return null;
  }
  const toggle = (ip) => {
    const next = selected.includes(ip) ? selected.filter((other) => other !== ip) : [...selected, ip];
    setNdiSetting('adapters', next.join(', '));
  };
  return (
    <div className={cx('grid gap-1', disabled && 'opacity-50')}>
      {usable.map((adapter) => (
        <label key={`${adapter.name}-${adapter.ip}`} className="text-xs">
          <input
            className="bg-background text-sm border border-muted focus:outline-none focus:ring-0 focus:border-foreground"
            type="checkbox"
            disabled={disabled}
            checked={selected.includes(adapter.ip)}
            onChange={() => toggle(adapter.ip)}
          />
          {` ${adapter.ip} (${adapter.name})`}
        </label>
      ))}
    </div>
  );
}

function Warning({ children }) {
  return <div className="text-xs border border-muted p-2 text-red-500">{children}</div>;
}

function Pre({ children }) {
  return (
    <pre className="text-xs border border-muted p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all select-text">
      {children}
    </pre>
  );
}

// adapters named in an NDI config that this machine does not have: NDI would then send on no adapter at all
function getMissingAdapters(configText, interfaces) {
  if (!configText || !interfaces) {
    return [];
  }
  try {
    const allowed = JSON.parse(configText)?.ndi?.adapters?.allowed ?? [];
    const local = interfaces.map((i) => i.ip);
    return allowed.filter((ip) => !local.includes(ip));
  } catch (err) {
    return [];
  }
}

function FeedStatus({ feed, capture }) {
  if (!feed?.running) {
    return (
      <tr>
        <td className="pr-3">{feed?.id}</td>
        <td className="opacity-60" colSpan={6}>
          off
        </td>
      </tr>
    );
  }
  const stalled = feed.msSinceFrame == null || feed.msSinceFrame > 2000;
  return (
    <tr>
      <td className="pr-3">{feed.id}</td>
      <td className="pr-3">{feed.name}</td>
      <td className="pr-3">{feed.connections}</td>
      <td className="pr-3">{feed.width ? `${feed.width}x${feed.height}` : '-'}</td>
      <td className={cx('pr-3', stalled && 'text-red-500')}>{stalled ? 'no frames' : `${feed.fps} fps`}</td>
      <td className="pr-3">{feed.framesSent}</td>
      <td>
        {capture
          ? `${capture.state === 'live' ? '' : `paused (${capture.state}), `}draw ${capture.renderMs.toFixed(1)}ms, send ${capture.sendMs.toFixed(1)}ms`
          : ''}
      </td>
    </tr>
  );
}

function Debug({ status, statusError }) {
  const capture = useStore($ndiCapture);
  const [sources, setSources] = useState();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState();

  const scan = async () => {
    setScanning(true);
    setScanError();
    try {
      setSources(await findNdiSources(3000));
    } catch (err) {
      setScanError(`${err}`);
    }
    setScanning(false);
  };

  if (statusError) {
    return <Warning>Could not read the NDI status: {statusError}</Warning>;
  }
  if (!status) {
    return <div className="text-xs opacity-60">loading...</div>;
  }
  const errors = [
    status.loadError,
    status.lastError,
    capture.configureError,
    ...status.feeds.map((feed) => feed.lastError && `${feed.id}: ${feed.lastError}`),
    capture.text?.error && `text: ${capture.text.error}`,
    capture.visuals?.error && `visuals: ${capture.visuals.error}`,
  ].filter(Boolean);
  const uniqueErrors = [...new Set(errors)];
  const missingAdapters = getMissingAdapters(status.effectiveConfig, status.interfaces);
  const ownNames = status.feeds.filter((feed) => feed.running).map((feed) => feed.name);
  return (
    <div className="space-y-3">
      {uniqueErrors.map((error) => (
        <Warning key={error}>{error}</Warning>
      ))}
      {missingAdapters.length > 0 && (
        <Warning>
          The network config only allows the adapter{missingAdapters.length > 1 ? 's' : ''} {missingAdapters.join(', ')}
          , which this machine does not have right now. Receivers will not be able to connect until the allowed adapters
          are changed.
        </Warning>
      )}
      <Field label="Runtime">
        <div className="text-xs select-text">
          {status.libraryLoaded
            ? `${status.version} (${status.libraryPath}), ${status.initialized ? 'running' : 'stopped'}`
            : status.loadError
              ? 'not available'
              : 'not loaded yet. It is loaded when the first feed is switched on.'}
        </div>
      </Field>
      <Field label="Feeds">
        <div className="overflow-auto">
          <table className="text-xs text-left select-text whitespace-nowrap">
            <thead>
              <tr className="opacity-60">
                <th className="pr-3 font-normal">feed</th>
                <th className="pr-3 font-normal">source name</th>
                <th className="pr-3 font-normal">receivers</th>
                <th className="pr-3 font-normal">size</th>
                <th className="pr-3 font-normal">rate</th>
                <th className="pr-3 font-normal">frames</th>
                <th className="font-normal">capture</th>
              </tr>
            </thead>
            <tbody>
              {status.feeds.map((feed) => (
                <FeedStatus key={feed.id} feed={feed} capture={capture[feed.id]} />
              ))}
            </tbody>
          </table>
        </div>
      </Field>
      <Field label="Network adapters of this machine">
        <div className="text-xs select-text">
          {status.interfaces.map((i) => `${i.ip} (${i.name}${i.isLoopback ? ', loopback' : ''})`).join(', ') ||
            'none found'}
        </div>
      </Field>
      <Field
        label="Sources visible on the network"
        hint="Scans for 3 seconds with the current settings. Your own feeds should show up here. If they do but another machine cannot see them, check the adapters, groups and firewall."
      >
        <div className="flex items-center space-x-3">
          <ActionButton onClick={scan} disabled={scanning}>
            {scanning ? 'scanning...' : 'scan for sources'}
          </ActionButton>
        </div>
        {scanError && <Warning>{scanError}</Warning>}
        {sources && (
          <Pre>
            {sources.length
              ? sources
                  .map(
                    (source) =>
                      `${source.name}  ${source.url}${ownNames.some((n) => source.name.includes(`(${n})`)) ? '  <- this app' : ''}`,
                  )
                  .join('\n')
              : 'no sources found'}
          </Pre>
        )}
      </Field>
      <Field
        label="Network config in use"
        hint={
          status.configSource === 'system'
            ? status.systemConfigPath
            : `${status.appConfigPath} (written by the settings above)`
        }
      >
        <Pre>
          {status.effectiveConfig ?? (status.initialized ? 'no config file, NDI defaults apply' : 'not started')}
        </Pre>
      </Field>
      {status.configSource !== 'system' && status.systemConfig && (
        <Field label="System NDI config (not used)" hint={status.systemConfigPath}>
          <Pre>{status.systemConfig}</Pre>
        </Field>
      )}
      <Field label="Log">
        <Pre>
          {status.log.length
            ? status.log
                .slice(-40)
                .map((line) => `${new Date(line.time).toLocaleTimeString()}  ${line.message}`)
                .join('\n')
            : 'nothing logged yet'}
        </Pre>
      </Field>
    </div>
  );
}

export function NdiSettings() {
  const settings = useStore($ndiSettings);
  const [status, setStatus] = useState();
  const [statusError, setStatusError] = useState();

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await getNdiStatus();
        if (active) {
          setStatus(next);
          setStatusError();
        }
      } catch (err) {
        active && setStatusError(`${err}`);
      }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const usesSystemConfig = settings.configSource === 'system';
  return (
    <div className="p-4 text-foreground space-y-6 w-full overflow-auto">
      <Section title="Feeds">
        <Field
          label="Framing"
          hint="Both feeds use the same framing, so drawings and widgets stay under their code when the feeds are layered, in any window size."
        >
          <Select
            settingKey="framing"
            options={{
              contain: 'whole editor, top left',
              width: 'fill frame width, follow the cursor',
              window: 'whole window',
            }}
          />
          {settings.framing === 'window' && (
            <Select
              settingKey="windowFit"
              options={{ contain: 'fit inside frame', stretch: 'stretch to frame', cover: 'fill frame (crop)' }}
            />
          )}
        </Field>
        <FeedSettings id="text" title="Text" description="The code editor with syntax colors and pattern highlights.">
          <Check settingKey="textTransparent" label="Transparent background (for overlays)" />
        </FeedSettings>
        <FeedSettings
          id="visuals"
          title="Visuals"
          description="Pianorolls, scopes, spirals and other drawings where they are on screen, without the code. They move with the code when it is scrolled."
        >
          <Check settingKey="visualsWidgets" label="Include inline widgets (._pianoroll(), ._scope() ...)" />
          <Check settingKey="visualsTransparent" label="Transparent background (for overlays)" />
        </FeedSettings>
      </Section>

      <Section title="Network">
        <Field
          label="Groups"
          hint="Comma separated NDI groups the feeds are announced in. Empty means the default group (Public)."
        >
          <Text settingKey="groups" placeholder="Public" />
        </Field>
        <Field label="Network config">
          <Select
            settingKey="configSource"
            options={{
              app: 'Use the settings below (only for Strudel)',
              system: 'Use the system NDI config (NDI Access Manager)',
            }}
          />
        </Field>
        <Field label="Machine name" hint="Shown in front of the source name. Empty means the computer name.">
          <Text settingKey="machineName" placeholder="computer name" disabled={usesSystemConfig} />
        </Field>
        <Field
          label="Send on adapters"
          hint="Local IP addresses NDI may use. Empty means all adapters. Pick one if receivers connect over the wrong network."
        >
          <AdapterPicker interfaces={status?.interfaces} disabled={usesSystemConfig} />
          <Text settingKey="adapters" placeholder="all adapters" disabled={usesSystemConfig} />
        </Field>
        <Field
          label="Discovery servers"
          hint="Comma separated addresses of NDI Discovery Servers. Empty means automatic discovery (mDNS), which only works within one subnet."
        >
          <Text settingKey="discoveryServers" placeholder="automatic (mDNS)" disabled={usesSystemConfig} />
        </Field>
        <Field
          label="Extra IPs"
          hint="Comma separated addresses of machines outside this subnet to look for sources on. Only affects the source scan below."
        >
          <Text settingKey="extraIps" placeholder="none" disabled={usesSystemConfig} />
        </Field>
        <Field label="Multicast">
          <Check settingKey="multicast" label="Send with multicast" disabled={usesSystemConfig} />
          {settings.multicast && !usesSystemConfig && (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Prefix">
                <Text settingKey="multicastPrefix" placeholder="239.255.0.0" />
              </Field>
              <Field label="Netmask">
                <Text settingKey="multicastMask" placeholder="255.255.0.0" />
              </Field>
              <Field label="TTL">
                <Text settingKey="multicastTtl" placeholder="1" />
              </Field>
            </div>
          )}
        </Field>
        {status?.restartRequired ? (
          <Warning>
            The NDI runtime reads these network settings only when it starts. Restart Strudel to apply the changes. This
            stops the sound. Your code is kept.
            <div className="pt-2">
              <ActionButton className="underline" onClick={() => restartAppForNdi()}>
                restart Strudel now
              </ActionButton>
            </div>
          </Warning>
        ) : (
          <div className="text-xs opacity-60">
            Groups and source names apply right away. The other network settings apply after Strudel is restarted.
          </div>
        )}
        <div className="flex items-center space-x-3">
          <ActionButton onClick={() => configureNdi(true)}>restart feeds</ActionButton>
          <ActionButton onClick={() => resetNdiSettings()}>restore NDI defaults</ActionButton>
        </div>
      </Section>

      <Section title="Debug">
        <Debug status={status} statusError={statusError} />
      </Section>
    </div>
  );
}
