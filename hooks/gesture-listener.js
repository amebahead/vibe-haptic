// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
var DEFAULT_GESTURE_CONFIG = {
  enabled: true,
  tapTimeout: 300,
  listenTimeout: 1e4
};
var DEFAULT_CONFIG = {
  patterns: {},
  events: {
    stop: "vibe",
    prompt: "alert"
  },
  gesture: { ...DEFAULT_GESTURE_CONFIG }
};
function getConfigPath(agent, scope) {
  const home = homedir();
  if (scope === "global") {
    return agent === "claude" ? `${home}/.claude/vibe-haptic.json` : `${home}/.config/opencode/vibe-haptic.json`;
  }
  return agent === "claude" ? ".claude/vibe-haptic.json" : ".opencode/vibe-haptic.json";
}
function mergeConfig(base, override) {
  return {
    patterns: { ...base.patterns, ...override.patterns },
    events: { ...base.events, ...override.events },
    gesture: { ...base.gesture, ...override.gesture }
  };
}
function loadConfig(agent = "claude") {
  let config = { ...DEFAULT_CONFIG };
  const globalPath = getConfigPath(agent, "global");
  if (existsSync(globalPath)) {
    try {
      const globalData = JSON.parse(readFileSync(globalPath, "utf-8"));
      config = mergeConfig(config, globalData);
    } catch {}
  }
  const localPath = getConfigPath(agent, "local");
  if (existsSync(localPath)) {
    try {
      const localData = JSON.parse(readFileSync(localPath, "utf-8"));
      config = mergeConfig(config, localData);
    } catch {}
  }
  return config;
}

// src/claude/gesture.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, unlinkSync, writeFileSync } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/haptic.ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/patterns.ts
var DEFAULT_INTENSITY = 1;
var DEFAULT_PATTERNS = {
  vibe: { beat: "6/0.8 3/1.0   6/1.0" },
  alert: { beat: "6/0.5 6/1.0 6/0.5" },
  dopamine: { beat: "6666666 5/1.0 4/1.0 3/1.0", intensity: 0.1 },
  noise: { beat: "6543654365436543" },
  "confirm-yes": { beat: "6/0.6 3/0.4" },
  "confirm-no": { beat: "6/1.0  6/1.0" }
};
function resolvePattern(nameOrBeat, patterns) {
  const isInlineBeat = /^[3-6/.\s]+$/.test(nameOrBeat);
  if (isInlineBeat) {
    return { beat: nameOrBeat };
  }
  const userPattern = patterns?.[nameOrBeat];
  if (userPattern) {
    if (typeof userPattern === "string") {
      return { beat: userPattern };
    }
    return {
      beat: userPattern.beat,
      intensity: userPattern.intensity
    };
  }
  const defaultPattern = DEFAULT_PATTERNS[nameOrBeat];
  if (defaultPattern) {
    return {
      beat: defaultPattern.beat,
      intensity: defaultPattern.intensity
    };
  }
  return null;
}

// src/haptic.ts
var PAUSE_DELAY_MS = 100;
function parseBeat(beat, defaultIntensity) {
  const tokens = [];
  let i = 0;
  while (i < beat.length) {
    const char = beat[i];
    if (char === " ") {
      let pauseCount = 0;
      while (i < beat.length && beat[i] === " ") {
        pauseCount++;
        i++;
      }
      tokens.push({ type: "pause", pauseCount });
    } else if (char >= "3" && char <= "6") {
      const actuation = Number(char);
      i++;
      if (i < beat.length && beat[i] === "/") {
        i++;
        let intensityStr = "";
        while (i < beat.length && beat[i] !== " ") {
          intensityStr += beat[i];
          i++;
        }
        const intensity = intensityStr ? Math.min(2, Math.max(0, parseFloat(intensityStr))) : defaultIntensity;
        tokens.push({ type: "tap", actuation, intensity });
      } else {
        tokens.push({ type: "tap", actuation, intensity: defaultIntensity });
      }
    } else {
      i++;
    }
  }
  return tokens;
}

class HapticEngine {
  config;
  nativeModule = null;
  constructor(config, options) {
    this.config = config;
    if (options?.nativeModule !== undefined) {
      this.nativeModule = options.nativeModule;
    } else {
      this.loadNativeModule();
    }
  }
  loadNativeModule() {
    if (process.platform !== "darwin") {
      return;
    }
    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const nativePath = join(currentDir, "..", "native", "vibe-haptic-native.node");
      const require2 = createRequire(import.meta.url);
      this.nativeModule = require2(nativePath);
    } catch {}
  }
  playBeat(pattern) {
    return new Promise((resolve) => {
      if (!this.nativeModule) {
        resolve();
        return;
      }
      const { beat, intensity } = pattern;
      const tokens = parseBeat(beat, intensity ?? DEFAULT_INTENSITY);
      const module = this.nativeModule;
      let i = 0;
      const playNext = () => {
        if (i >= tokens.length) {
          resolve();
          return;
        }
        const token = tokens[i];
        i++;
        if (token.type === "pause") {
          setTimeout(playNext, (token.pauseCount ?? 1) * PAUSE_DELAY_MS);
        } else {
          module.actuate(token.actuation, token.intensity);
          playNext();
        }
      };
      playNext();
    });
  }
  trigger(patternName) {
    const pattern = resolvePattern(patternName, this.config.patterns);
    if (pattern) {
      return this.playBeat(pattern);
    }
    return Promise.resolve();
  }
  triggerForEvent(event) {
    const patternName = this.config.events?.[event];
    if (patternName) {
      return this.trigger(patternName);
    }
    return Promise.resolve();
  }
}
function createHapticEngine(agent) {
  return new HapticEngine(loadConfig(agent));
}

// src/claude/gesture.ts
var LOCK_FILE = "/tmp/vibe-haptic-gesture.lock";
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireGestureLock() {
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {}
  try {
    const existingPid = parseInt(readFileSync2(LOCK_FILE, "utf-8").trim(), 10);
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      return false;
    }
  } catch {}
  writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
function releaseGestureLock() {
  try {
    if (existsSync2(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {}
}
async function handlePermissionGesture(terminalPid, options) {
  const native = options?.nativeModule ?? loadNativeModule();
  if (!native)
    return;
  const gestureConfig = options?.config?.gesture ?? {
    enabled: true,
    tapTimeout: 300,
    listenTimeout: 1e4
  };
  if (!gestureConfig.enabled)
    return;
  if (!acquireGestureLock())
    return;
  process.once("exit", releaseGestureLock);
  process.once("SIGTERM", () => {
    releaseGestureLock();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    releaseGestureLock();
    process.exit(0);
  });
  const engine = createHapticEngine("claude");
  let answered = false;
  return new Promise((resolve) => {
    const cleanup = () => {
      native.stopTouchListener();
      releaseGestureLock();
      resolve();
    };
    native.startTouchListener((gesture) => {
      if (answered)
        return;
      answered = true;
      const key = gesture === "single" ? "y" : "n";
      native.sendKeystrokeToTerminal(terminalPid, key);
      const pattern = gesture === "single" ? "confirm-yes" : "confirm-no";
      if (options?.onPatternTriggered) {
        options.onPatternTriggered(pattern);
      }
      engine.trigger(pattern);
      cleanup();
    }, gestureConfig.tapTimeout);
    setTimeout(() => {
      if (!answered) {
        cleanup();
      }
    }, gestureConfig.listenTimeout);
  });
}
function loadNativeModule() {
  try {
    const currentDir = dirname2(fileURLToPath2(import.meta.url));
    const nativePath = join2(currentDir, "..", "native", "vibe-haptic-native.node");
    const require2 = createRequire2(import.meta.url);
    return require2(nativePath);
  } catch {
    return null;
  }
}

// src/bin/gesture-listener.ts
var DEFAULT_GESTURE_CONFIG2 = {
  enabled: true,
  tapTimeout: 300,
  listenTimeout: 1e4
};
async function main() {
  const terminalPid = parseInt(process.argv[2], 10);
  if (Number.isNaN(terminalPid)) {
    process.exit(1);
  }
  const config = loadConfig("claude");
  const gestureConfig = {
    ...DEFAULT_GESTURE_CONFIG2,
    ...config.gesture
  };
  if (!gestureConfig.enabled) {
    process.exit(0);
  }
  await handlePermissionGesture(terminalPid, {
    config: { gesture: gestureConfig }
  });
  process.exit(0);
}
main().catch(() => process.exit(1));
