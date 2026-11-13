//! NDI output for the desktop app.
//!
//! The NDI runtime (libndi) is proprietary, so it is loaded dynamically at runtime instead of being
//! linked at build time. If it is missing, the app still works and the NDI settings tab says why.
//!
//! The frontend renders each feed ("text" and "visuals") into a canvas and posts raw RGBA frames to
//! `ndi_send_frame`. Network settings are written to an app-specific `ndi-config.v1.json`, which the
//! runtime picks up through the `NDI_CONFIG_DIR` environment variable.

use libloading::Library;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FEED_IDS: [&str; 2] = ["text", "visuals"];
const CONFIG_FILE: &str = "ndi-config.v1.json";
const MAX_LOG_LINES: usize = 200;
const MAX_DIMENSION: u32 = 8192;

/* ...........................................................
                      NDI C structures
............................................................*/

#[repr(C)]
struct SendCreate {
  p_ndi_name: *const c_char,
  p_groups: *const c_char,
  clock_video: bool,
  clock_audio: bool,
}

#[repr(C)]
struct VideoFrameV2 {
  xres: c_int,
  yres: c_int,
  fourcc: u32,
  frame_rate_n: c_int,
  frame_rate_d: c_int,
  picture_aspect_ratio: f32,
  frame_format_type: c_int,
  timecode: i64,
  p_data: *const u8,
  line_stride_in_bytes: c_int,
  p_metadata: *const c_char,
  timestamp: i64,
}

#[repr(C)]
struct Source {
  p_ndi_name: *const c_char,
  p_url_address: *const c_char,
}

#[repr(C)]
struct FindCreate {
  show_local_sources: bool,
  p_groups: *const c_char,
  p_extra_ips: *const c_char,
}

const FOURCC_RGBA: u32 = u32::from_le_bytes(*b"RGBA");
const FRAME_FORMAT_PROGRESSIVE: c_int = 1;
const TIMECODE_SYNTHESIZE: i64 = i64::MAX;

struct Api {
  _lib: Library,
  path: String,
  initialize: unsafe extern "C" fn() -> bool,
  version: unsafe extern "C" fn() -> *const c_char,
  send_create: unsafe extern "C" fn(*const SendCreate) -> *mut c_void,
  send_destroy: unsafe extern "C" fn(*mut c_void),
  send_video: unsafe extern "C" fn(*mut c_void, *const VideoFrameV2),
  send_connections: unsafe extern "C" fn(*mut c_void, u32) -> c_int,
  find_create: unsafe extern "C" fn(*const FindCreate) -> *mut c_void,
  find_destroy: unsafe extern "C" fn(*mut c_void),
  find_wait: unsafe extern "C" fn(*mut c_void, u32) -> bool,
  find_sources: unsafe extern "C" fn(*mut c_void, *mut u32) -> *const Source,
}

fn library_candidates() -> Vec<PathBuf> {
  let file_names: &[&str] = if cfg!(target_os = "windows") {
    &["Processing.NDI.Lib.x64.dll"]
  } else if cfg!(target_os = "macos") {
    &["libndi.dylib", "libndi_advanced.dylib"]
  } else {
    &["libndi.so.6", "libndi.so.5", "libndi.so"]
  };
  let mut dirs: Vec<PathBuf> = Vec::new();
  for var in [
    "NDI_RUNTIME_DIR_V6",
    "NDI_RUNTIME_DIR_V5",
    "NDI_RUNTIME_DIR_V4",
    "NDI_RUNTIME_DIR_V3",
  ] {
    if let Ok(dir) = std::env::var(var) {
      if !dir.is_empty() {
        dirs.push(PathBuf::from(dir));
      }
    }
  }
  if cfg!(target_os = "macos") {
    dirs.push(PathBuf::from("/usr/local/lib"));
    dirs.push(PathBuf::from("/Library/NDI SDK for Apple/lib/macOS"));
    dirs.push(PathBuf::from("/Library/NDI Advanced SDK for Apple/lib/macOS"));
  } else if cfg!(target_os = "linux") {
    dirs.push(PathBuf::from("/usr/lib"));
    dirs.push(PathBuf::from("/usr/local/lib"));
    dirs.push(PathBuf::from("/usr/lib/x86_64-linux-gnu"));
  }
  let mut candidates = Vec::new();
  for dir in &dirs {
    for name in file_names {
      candidates.push(dir.join(name));
    }
  }
  // last resort: let the dynamic loader search its default paths
  for name in file_names {
    candidates.push(PathBuf::from(name));
  }
  candidates
}

fn load_api() -> Result<Api, String> {
  let mut errors = Vec::new();
  for candidate in library_candidates() {
    if candidate.is_absolute() && !candidate.exists() {
      continue;
    }
    let lib = match unsafe { Library::new(&candidate) } {
      Ok(lib) => lib,
      Err(err) => {
        errors.push(format!("{}: {}", candidate.display(), err));
        continue;
      }
    };
    macro_rules! symbol {
      ($name:literal) => {
        match unsafe { lib.get(concat!($name, "\0").as_bytes()) } {
          Ok(symbol) => *symbol,
          Err(err) => {
            errors.push(format!("{}: missing {}: {}", candidate.display(), $name, err));
            continue;
          }
        }
      };
    }
    return Ok(Api {
      path: candidate.display().to_string(),
      initialize: symbol!("NDIlib_initialize"),
      version: symbol!("NDIlib_version"),
      send_create: symbol!("NDIlib_send_create"),
      send_destroy: symbol!("NDIlib_send_destroy"),
      send_video: symbol!("NDIlib_send_send_video_v2"),
      send_connections: symbol!("NDIlib_send_get_no_connections"),
      find_create: symbol!("NDIlib_find_create_v2"),
      find_destroy: symbol!("NDIlib_find_destroy"),
      find_wait: symbol!("NDIlib_find_wait_for_sources"),
      find_sources: symbol!("NDIlib_find_get_current_sources"),
      _lib: lib,
    });
  }
  let mut message = String::from(
    "NDI runtime not found. Install NDI Tools (https://ndi.video/tools/) or set NDI_RUNTIME_DIR_V6 to the folder that contains the NDI library.",
  );
  if !errors.is_empty() {
    message.push_str(" Tried: ");
    message.push_str(&errors.join("; "));
  }
  Err(message)
}

fn cstring_or_null(value: &str) -> Option<CString> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    None
  } else {
    CString::new(trimmed).ok()
  }
}

fn ptr_or_null(value: &Option<CString>) -> *const c_char {
  value.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null())
}

unsafe fn string_from_ptr(ptr: *const c_char) -> String {
  if ptr.is_null() {
    String::new()
  } else {
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
  }
}

/* ...........................................................
                          Settings
............................................................*/

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NdiSettings {
  pub text_enabled: bool,
  pub visuals_enabled: bool,
  pub text_name: String,
  pub visuals_name: String,
  /// comma separated NDI groups the feeds are announced in. empty = "Public"
  pub groups: String,
  /// "app": use the settings below. "system": use the machine wide config (~/.ndi)
  pub config_source: String,
  pub machine_name: String,
  /// comma separated discovery server addresses. empty = mDNS
  pub discovery_servers: String,
  /// comma separated extra IPs to look for sources on (only affects the source scan)
  pub extra_ips: String,
  /// comma separated local adapter IPs NDI is allowed to use. empty = all
  pub adapters: String,
  pub multicast: bool,
  pub multicast_prefix: String,
  pub multicast_mask: String,
  pub multicast_ttl: u32,
}

impl Default for NdiSettings {
  fn default() -> Self {
    NdiSettings {
      text_enabled: false,
      visuals_enabled: false,
      text_name: "Strudel Text".to_string(),
      visuals_name: "Strudel Visuals".to_string(),
      groups: String::new(),
      config_source: "app".to_string(),
      machine_name: String::new(),
      discovery_servers: String::new(),
      extra_ips: String::new(),
      adapters: String::new(),
      multicast: false,
      multicast_prefix: "239.255.0.0".to_string(),
      multicast_mask: "255.255.0.0".to_string(),
      multicast_ttl: 1,
    }
  }
}

fn split_list(value: &str) -> Vec<String> {
  value
    .split(|c: char| c == ',' || c.is_whitespace())
    .map(|part| part.trim().to_string())
    .filter(|part| !part.is_empty())
    .collect()
}

fn build_config_json(settings: &NdiSettings) -> String {
  let mut ndi = serde_json::Map::new();
  let machine_name = settings.machine_name.trim();
  if !machine_name.is_empty() {
    ndi.insert("machinename".into(), serde_json::json!(machine_name));
  }
  let mut networks = serde_json::Map::new();
  let discovery = split_list(&settings.discovery_servers);
  if !discovery.is_empty() {
    networks.insert("discovery".into(), serde_json::json!(discovery.join(",")));
  }
  let extra_ips = split_list(&settings.extra_ips);
  if !extra_ips.is_empty() {
    networks.insert("ips".into(), serde_json::json!(extra_ips.join(",")));
  }
  if !networks.is_empty() {
    ndi.insert("networks".into(), serde_json::Value::Object(networks));
  }
  let adapters = split_list(&settings.adapters);
  if !adapters.is_empty() {
    ndi.insert("adapters".into(), serde_json::json!({ "allowed": adapters }));
  }
  let mut multicast_send = serde_json::Map::new();
  multicast_send.insert("enable".into(), serde_json::json!(settings.multicast));
  if settings.multicast {
    multicast_send.insert("netprefix".into(), serde_json::json!(settings.multicast_prefix.trim()));
    multicast_send.insert("netmask".into(), serde_json::json!(settings.multicast_mask.trim()));
    multicast_send.insert("ttl".into(), serde_json::json!(settings.multicast_ttl));
  }
  ndi.insert("multicast".into(), serde_json::json!({ "send": multicast_send }));
  serde_json::to_string_pretty(&serde_json::json!({ "ndi": ndi })).unwrap_or_else(|_| "{}".to_string())
}

fn system_config_path() -> Option<PathBuf> {
  if cfg!(target_os = "windows") {
    std::env::var_os("ProgramData").map(|dir| PathBuf::from(dir).join("NDI").join(CONFIG_FILE))
  } else {
    std::env::var_os("HOME").map(|dir| PathBuf::from(dir).join(".ndi").join(CONFIG_FILE))
  }
}

/* ...........................................................
                           Senders
............................................................*/

struct Sender {
  api: Arc<Api>,
  ptr: *mut c_void,
  name: String,
  groups: String,
  frames_sent: u64,
  frame_times: VecDeque<Instant>,
  last_send_ms: f64,
  width: u32,
  height: u32,
  last_error: Option<String>,
}

// the sender pointer is only ever used while holding the mutex around the Sender
unsafe impl Send for Sender {}

impl Sender {
  fn destroy(&mut self) {
    if !self.ptr.is_null() {
      unsafe { (self.api.send_destroy)(self.ptr) };
      self.ptr = std::ptr::null_mut();
    }
  }

  fn send(&mut self, data: &[u8], width: u32, height: u32, fps: f64) -> Result<(), String> {
    if self.ptr.is_null() {
      return Err("feed is not running".to_string());
    }
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || data.len() != expected {
      let message = format!(
        "bad frame: {}x{} needs {} bytes, got {}",
        width,
        height,
        expected,
        data.len()
      );
      self.last_error = Some(message.clone());
      return Err(message);
    }
    let fps = if fps.is_finite() && fps > 0.0 { fps } else { 30.0 };
    let frame = VideoFrameV2 {
      xres: width as c_int,
      yres: height as c_int,
      fourcc: FOURCC_RGBA,
      frame_rate_n: (fps * 1000.0).round() as c_int,
      frame_rate_d: 1000,
      picture_aspect_ratio: width as f32 / height as f32,
      frame_format_type: FRAME_FORMAT_PROGRESSIVE,
      timecode: TIMECODE_SYNTHESIZE,
      p_data: data.as_ptr(),
      line_stride_in_bytes: (width * 4) as c_int,
      p_metadata: std::ptr::null(),
      timestamp: 0,
    };
    let started = Instant::now();
    // synchronous: the frame is fully consumed before this returns, so `data` may be freed afterwards
    unsafe { (self.api.send_video)(self.ptr, &frame) };
    let now = Instant::now();
    self.last_send_ms = now.duration_since(started).as_secs_f64() * 1000.0;
    self.frames_sent += 1;
    self.width = width;
    self.height = height;
    self.last_error = None;
    self.frame_times.push_back(now);
    while let Some(first) = self.frame_times.front() {
      if now.duration_since(*first) > Duration::from_secs(2) {
        self.frame_times.pop_front();
      } else {
        break;
      }
    }
    Ok(())
  }
}

impl Drop for Sender {
  fn drop(&mut self) {
    self.destroy();
  }
}

/* ...........................................................
                            State
............................................................*/

#[derive(Serialize, Clone)]
pub struct LogLine {
  time: u64,
  message: String,
}

struct Inner {
  app_config_dir: PathBuf,
  api: Option<Arc<Api>>,
  load_error: Option<String>,
  initialized: bool,
  /// the network settings the running runtime was started with
  network_key: Option<String>,
  /// the network settings that were saved last. differs from network_key until the app is restarted
  pending_network_key: Option<String>,
  effective_config: Option<String>,
  settings: NdiSettings,
  last_error: Option<String>,
  feeds: HashMap<String, Arc<Mutex<Sender>>>,
  log: VecDeque<LogLine>,
}

pub struct NdiState {
  inner: Mutex<Inner>,
}

impl NdiState {
  pub fn new(app_config_dir: PathBuf) -> Self {
    NdiState {
      inner: Mutex::new(Inner {
        app_config_dir,
        api: None,
        load_error: None,
        initialized: false,
        network_key: None,
        pending_network_key: None,
        effective_config: None,
        settings: NdiSettings::default(),
        last_error: None,
        feeds: HashMap::new(),
        log: VecDeque::new(),
      }),
    }
  }
}

impl Inner {
  fn log(&mut self, message: impl Into<String>) {
    let message = message.into();
    println!("[ndi] {}", message);
    let time = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0);
    self.log.push_back(LogLine { time, message });
    while self.log.len() > MAX_LOG_LINES {
      self.log.pop_front();
    }
  }

  fn config_dir(&self) -> PathBuf {
    self.app_config_dir.join("ndi")
  }

  fn stop_feeds(&mut self) {
    let feeds: Vec<(String, Arc<Mutex<Sender>>)> = self.feeds.drain().collect();
    for (id, feed) in feeds {
      // destroy explicitly: an in-flight frame might still hold a reference to the sender
      if let Ok(mut sender) = feed.lock() {
        sender.destroy();
      }
      self.log(format!("stopped feed \"{}\"", id));
    }
  }

  /// writes the app's network config file and returns its content
  fn prepare_config_file(&mut self, settings: &NdiSettings) -> Result<String, String> {
    let dir = self.config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
    let json = build_config_json(settings);
    let path = dir.join(CONFIG_FILE);
    std::fs::write(&path, &json).map_err(|e| format!("could not write {}: {}", path.display(), e))?;
    Ok(json)
  }

  /// writes the network config and points the runtime at it. returns the config the runtime will use
  fn prepare_config(&mut self, settings: &NdiSettings) -> Result<Option<String>, String> {
    let json = self.prepare_config_file(settings)?;
    if settings.config_source == "system" {
      std::env::remove_var("NDI_CONFIG_DIR");
      let system = system_config_path().and_then(|path| std::fs::read_to_string(path).ok());
      return Ok(system);
    }
    std::env::set_var("NDI_CONFIG_DIR", self.config_dir());
    Ok(Some(json))
  }

  fn apply(&mut self, settings: NdiSettings, force: bool) -> Result<(), String> {
    let wants_output = settings.text_enabled || settings.visuals_enabled;
    let network_key = format!("{}|{}", settings.config_source, build_config_json(&settings));
    let network_changed = self.network_key.as_deref() != Some(network_key.as_str());

    if force {
      self.stop_feeds();
    }
    self.settings = settings.clone();
    if self.initialized && network_changed && self.pending_network_key.as_deref() != Some(network_key.as_str()) {
      // The runtime reads its network config once per process: re-initializing or even reloading the
      // library does not pick up changes. So save the config for the next start and ask for a restart.
      self.prepare_config_file(&settings)?;
      self.pending_network_key = Some(network_key.clone());
      self.log("network settings saved. They apply after the app is restarted");
    }
    if !wants_output && !self.initialized {
      // nothing to send: don't load or start the runtime until a feed is switched on
      return Ok(());
    }

    if !self.initialized {
      // the config must be in place before the runtime is loaded and started
      self.effective_config = self.prepare_config(&settings)?;
      if self.api.is_none() {
        match load_api() {
          Ok(api) => {
            let version = unsafe { string_from_ptr((api.version)()) };
            self.log(format!("loaded {} ({})", api.path, version));
            self.load_error = None;
            self.api = Some(Arc::new(api));
          }
          Err(err) => {
            self.load_error = Some(err.clone());
            return Err(err);
          }
        }
      }
      let api = self.api.clone().unwrap();
      if !unsafe { (api.initialize)() } {
        return Err("NDIlib_initialize failed. The CPU might not be supported by the NDI runtime.".to_string());
      }
      self.initialized = true;
      self.network_key = Some(network_key.clone());
      self.pending_network_key = Some(network_key);
      self.log(format!(
        "NDI runtime started with the {} network config",
        if settings.config_source == "system" { "system" } else { "app" }
      ));
    }

    let api = self.api.clone().unwrap();
    let wanted = [
      ("text", settings.text_enabled, settings.text_name.trim().to_string()),
      ("visuals", settings.visuals_enabled, settings.visuals_name.trim().to_string()),
    ];
    let groups = settings.groups.trim().to_string();
    for (id, enabled, name) in wanted {
      let name = if name.is_empty() { format!("Strudel {}", id) } else { name };
      let up_to_date = self
        .feeds
        .get(id)
        .and_then(|feed| feed.lock().ok().map(|s| s.name == name && s.groups == groups && !s.ptr.is_null()))
        .unwrap_or(false);
      if enabled && up_to_date {
        continue;
      }
      if let Some(feed) = self.feeds.remove(id) {
        if let Ok(mut sender) = feed.lock() {
          sender.destroy();
        }
        self.log(format!("stopped feed \"{}\"", id));
      }
      if !enabled {
        continue;
      }
      let name_c = CString::new(name.clone()).map_err(|_| "feed name contains a NUL byte".to_string())?;
      let groups_c = cstring_or_null(&groups);
      let create = SendCreate {
        p_ndi_name: name_c.as_ptr(),
        p_groups: ptr_or_null(&groups_c),
        // the frontend paces the frames, so the sender must not block to clock them
        clock_video: false,
        clock_audio: false,
      };
      let ptr = unsafe { (api.send_create)(&create) };
      if ptr.is_null() {
        let message = format!(
          "could not create NDI sender \"{}\". Is another source on this machine already using that name?",
          name
        );
        self.log(message.clone());
        return Err(message);
      }
      self.log(format!(
        "started feed \"{}\" as \"{}\"{}",
        id,
        name,
        if groups.is_empty() { String::new() } else { format!(" in groups \"{}\"", groups) }
      ));
      self.feeds.insert(
        id.to_string(),
        Arc::new(Mutex::new(Sender {
          api: api.clone(),
          ptr,
          name,
          groups: groups.clone(),
          frames_sent: 0,
          frame_times: VecDeque::new(),
          last_send_ms: 0.0,
          width: 0,
          height: 0,
          last_error: None,
        })),
      );
    }
    Ok(())
  }
}

/* ...........................................................
                          Commands
............................................................*/

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceInfo {
  name: String,
  ip: String,
  is_loopback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
  id: String,
  running: bool,
  name: String,
  groups: String,
  connections: i32,
  frames_sent: u64,
  fps: f64,
  width: u32,
  height: u32,
  last_send_ms: f64,
  ms_since_frame: Option<u64>,
  last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdiStatus {
  library_loaded: bool,
  library_path: Option<String>,
  version: Option<String>,
  load_error: Option<String>,
  initialized: bool,
  /// network settings were changed after the runtime started. they apply after an app restart
  restart_required: bool,
  last_error: Option<String>,
  config_source: String,
  app_config_path: String,
  system_config_path: Option<String>,
  system_config: Option<String>,
  effective_config: Option<String>,
  interfaces: Vec<InterfaceInfo>,
  feeds: Vec<FeedStatus>,
  log: Vec<LogLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
  name: String,
  url: String,
}

fn list_interfaces() -> Vec<InterfaceInfo> {
  if_addrs::get_if_addrs()
    .unwrap_or_default()
    .into_iter()
    .filter(|interface| interface.ip().is_ipv4())
    .map(|interface| InterfaceInfo {
      name: interface.name.clone(),
      ip: interface.ip().to_string(),
      is_loopback: interface.is_loopback(),
    })
    .collect()
}

/// applies the settings: (re)starts the runtime when the network config changed and starts / stops feeds
#[tauri::command]
pub async fn ndi_configure(
  settings: NdiSettings,
  force: Option<bool>,
  state: tauri::State<'_, NdiState>,
) -> Result<(), String> {
  let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
  let result = inner.apply(settings, force.unwrap_or(false));
  match &result {
    Ok(()) => inner.last_error = None,
    Err(err) => {
      inner.last_error = Some(err.clone());
      inner.log(format!("error: {}", err));
    }
  }
  result
}

/// receives one RGBA frame. the pixels are the raw request body, the frame description is in the headers.
/// returns the number of receivers that are connected to the feed
#[tauri::command]
pub async fn ndi_send_frame(request: tauri::ipc::Request<'_>, state: tauri::State<'_, NdiState>) -> Result<i32, String> {
  let header = |name: &str| -> Option<&str> { request.headers().get(name).and_then(|value| value.to_str().ok()) };
  let feed_id = header("x-feed").ok_or("missing x-feed header")?.to_string();
  let width: u32 = header("x-width").and_then(|v| v.parse().ok()).ok_or("missing x-width header")?;
  let height: u32 = header("x-height").and_then(|v| v.parse().ok()).ok_or("missing x-height header")?;
  let fps: f64 = header("x-fps").and_then(|v| v.parse().ok()).unwrap_or(30.0);
  let data = match request.body() {
    tauri::ipc::InvokeBody::Raw(data) => data,
    _ => return Err("expected a binary frame".to_string()),
  };
  let feed = {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.feeds.get(&feed_id).cloned()
  };
  let feed = feed.ok_or_else(|| format!("feed \"{}\" is not running", feed_id))?;
  let mut sender = feed.lock().map_err(|e| e.to_string())?;
  sender.send(data, width, height, fps)?;
  // the frontend slows down to a trickle while nobody is receiving
  Ok(unsafe { (sender.api.send_connections)(sender.ptr, 0) })
}

#[tauri::command]
pub async fn ndi_status(state: tauri::State<'_, NdiState>) -> Result<NdiStatus, String> {
  let inner = state.inner.lock().map_err(|e| e.to_string())?;
  let now = Instant::now();
  let feeds = FEED_IDS
    .iter()
    .map(|id| {
      let stopped = FeedStatus {
        id: id.to_string(),
        running: false,
        name: String::new(),
        groups: String::new(),
        connections: 0,
        frames_sent: 0,
        fps: 0.0,
        width: 0,
        height: 0,
        last_send_ms: 0.0,
        ms_since_frame: None,
        last_error: None,
      };
      let Some(feed) = inner.feeds.get(*id) else { return stopped };
      let Ok(sender) = feed.lock() else { return stopped };
      if sender.ptr.is_null() {
        return stopped;
      }
      let recent = sender
        .frame_times
        .iter()
        .filter(|time| now.duration_since(**time) <= Duration::from_secs(1))
        .count();
      FeedStatus {
        id: id.to_string(),
        running: true,
        name: sender.name.clone(),
        groups: sender.groups.clone(),
        connections: unsafe { (sender.api.send_connections)(sender.ptr, 0) },
        frames_sent: sender.frames_sent,
        fps: recent as f64,
        width: sender.width,
        height: sender.height,
        last_send_ms: sender.last_send_ms,
        ms_since_frame: sender.frame_times.back().map(|time| now.duration_since(*time).as_millis() as u64),
        last_error: sender.last_error.clone(),
      }
    })
    .collect();
  let system_path = system_config_path();
  Ok(NdiStatus {
    library_loaded: inner.api.is_some(),
    library_path: inner.api.as_ref().map(|api| api.path.clone()),
    version: inner.api.as_ref().map(|api| unsafe { string_from_ptr((api.version)()) }),
    load_error: inner.load_error.clone(),
    initialized: inner.initialized,
    restart_required: inner.initialized && inner.pending_network_key != inner.network_key,
    last_error: inner.last_error.clone(),
    config_source: inner.settings.config_source.clone(),
    app_config_path: inner.config_dir().join(CONFIG_FILE).display().to_string(),
    system_config: system_path.as_ref().and_then(|path| std::fs::read_to_string(path).ok()),
    system_config_path: system_path.map(|path| path.display().to_string()),
    effective_config: inner.effective_config.clone(),
    interfaces: list_interfaces(),
    feeds,
    log: inner.log.iter().cloned().collect(),
  })
}

/// restarts the app, so that changed network settings are picked up by the NDI runtime
#[tauri::command]
pub fn ndi_restart_app(app: tauri::AppHandle) {
  app.restart();
}

/// looks for NDI sources on the network, to check that discovery works with the current settings
#[tauri::command]
pub async fn ndi_find_sources(
  timeout_ms: Option<u32>,
  state: tauri::State<'_, NdiState>,
) -> Result<Vec<SourceInfo>, String> {
  let (api, groups) = {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    if !inner.initialized {
      return Err("NDI is not running. Enable a feed first.".to_string());
    }
    (inner.api.clone().ok_or("NDI runtime is not loaded")?, inner.settings.groups.clone())
  };
  let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).min(15000) as u64);
  tauri::async_runtime::spawn_blocking(move || {
    let groups_c = cstring_or_null(&groups);
    let create = FindCreate {
      show_local_sources: true,
      p_groups: ptr_or_null(&groups_c),
      p_extra_ips: std::ptr::null(),
    };
    let finder = unsafe { (api.find_create)(&create) };
    if finder.is_null() {
      return Err("could not create NDI finder".to_string());
    }
    let started = Instant::now();
    // sources trickle in while discovery runs, so keep waiting for the whole timeout
    while started.elapsed() < timeout {
      unsafe { (api.find_wait)(finder, 250) };
    }
    let mut count: u32 = 0;
    let sources = unsafe { (api.find_sources)(finder, &mut count) };
    let mut found = Vec::new();
    if !sources.is_null() {
      for i in 0..count as usize {
        let source = unsafe { &*sources.add(i) };
        found.push(SourceInfo {
          name: unsafe { string_from_ptr(source.p_ndi_name) },
          url: unsafe { string_from_ptr(source.p_url_address) },
        });
      }
    }
    unsafe { (api.find_destroy)(finder) };
    Ok(found)
  })
  .await
  .map_err(|e| e.to_string())?
}
