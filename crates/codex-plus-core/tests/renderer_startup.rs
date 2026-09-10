use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn renderer_waits_for_native_react_mount_before_running_enhancements() {
    let source = codex_plus_core::assets::renderer_script();
    // 只执行真实启动入口；后续 UI 安装以计数器代替，避免模拟整个 Codex DOM。
    let prefix = source
        .split("  const codexPlusIsWindowsPlatform")
        .next()
        .unwrap();
    let script = format!("{prefix}\nwindow.started += 1;\n}})();");
    let test = r#"
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
let root = null, now = 0, nextId = 0;
const timers = new Map();
const window = {
  location: { href: 'app://-/index.html' }, electronBridge: {}, started: 0,
  setInterval(fn) { timers.set(++nextId, fn); return nextId; },
  clearInterval(id) { timers.delete(id); },
};
window.top = window.self = window;
const context = vm.createContext({ window, Date: { now: () => now }, console,
  document: { readyState: 'complete', body: {}, getElementById: () => root },
});
const run = () => vm.runInContext(source, context);
const tick = () => [...timers.values()].forEach(fn => fn());
run();
assert.equal(window.started, 0, 'enhancements must not run on the native splash screen');
run();
assert.equal(timers.size, 1, 'reinjection must reuse the pending startup wait');
root = {};
tick();
assert.equal(window.started, 0, 'document complete is not React ready');
root['__reactContainer$test'] = {};
tick();
assert.equal(window.started, 1, 'native mount must release the pending injection');
assert.equal(timers.size, 0, 'successful startup must release its timer');
run();
assert.equal(window.started, 2, 'already mounted pages must support immediate reinjection');
root = null;
run();
now = 60000;
tick();
assert.equal(window.started, 2, 'a failed native startup must not run enhancements');
assert.equal(timers.size, 0, 'startup polling must be bounded');
"#;
    let mut child = Command::new("node")
        .arg("-e")
        .arg(test)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node is required for renderer behavior tests");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&script).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
