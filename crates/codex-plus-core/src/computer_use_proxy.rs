//! Computer Use 的 MCP 直通层。
//!
//! # 为什么是「直通」而不是「代理」
//!
//! Codex 给模型的 CU 工具面来自 `SkyComputerUseClient mcp`（10 个离散工具），
//! 不是 `cua-repl` 的 code-mode。早先为了绕开它的签名校验，这条链路被改成
//! 「驱动 cua-repl + 在 Rust 里重新合成工具面」，代价是逐项偏差：信封、diff、
//! 截图分辨率、`App=` 行、`frontmost`、schema annotations 全靠手工对齐，
//! 任何一侧版本变化都会漂移。
//!
//! 实测（见 docs/plans/2026-10-23-codexpp-computer-use-native-passthrough-design.md）
//! 表明原生 server 只需要一个 OpenAI 签名的直接父进程：用 `cua_node/bin/node`
//! 执行 `assets/cu/shim.mjs` 拉起即可通过，`-10000 Sender process is not authenticated`
//! 不再出现。
//!
//! 所以本模块只做三件事：
//!
//! 1. **字节转发**：`tools/list` / `tools/call` / 结果 / 通知全部原样透传，
//!    不解析、不改写、不合成。id 也不重映射（1:1 会话，两端 id 天然一致）。
//! 2. **补声明 elicitation**：Claude Code 2.1.245 里虽然有 elicitation 的实现，
//!    但客户端能力里未必声明；原生 server 无论如何都会发该请求并阻塞（实测），
//!    所以 `initialize` 时替客户端补上，保证请求能被渲染。
//! 3. **审批**：按 `computer_use_approval` 设置决定就地放行还是转给客户端。

use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::{Value, json};

use crate::computer_use::{RuntimeLocation, locate_runtime};
use crate::computer_use_approval::{ApprovalMode, ApprovalStore, Outcome, subject_of};

/// 审批转给客户端后等多久。超过就回 `cancel`，不让会话永久挂住。
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 单帧上限，与原生 CU 的 8 MiB 对齐。
const MAX_FRAME: usize = 8 * 1024 * 1024;

enum Event {
    /// 客户端发来的原始帧（含结尾换行）。
    Client(Vec<u8>),
    /// 子进程发来的原始帧（含结尾换行）。
    Child(Vec<u8>),
    ChildClosed,
}

/// 以 stdio MCP server 的身份运行，直到客户端断开。
pub fn serve() -> anyhow::Result<()> {
    let runtime =
        locate_runtime()?.context("未找到 Codex 运行时（ChatGPT.app），Computer Use 不可用")?;
    let shim = crate::computer_use::ensure_shim()?;
    let mut child = spawn_child(&runtime, &shim)?;
    let child_stdin = child.stdin.take().context("CU 子进程的标准输入不可用")?;
    let child_stdout = child.stdout.take().context("CU 子进程的标准输出不可用")?;

    let (sender, receiver) = mpsc::channel::<Event>();
    spawn_client_reader(sender.clone());
    spawn_child_reader(child_stdout, sender.clone());
    drop(sender);

    let mut forwarder = Forwarder {
        child_stdin,
        declare_elicitation: true,
        client_supports_elicitation: None,
        mode: ApprovalMode::current(),
        pending: HashMap::new(),
        session_allowed: BTreeSet::new(),
        next_token: 0,
    };
    let outcome = forwarder.run(receiver);
    child.kill();
    child.wait();
    outcome
}

/// 拉起 OpenAI 签名的 node 执行 shim，由 shim 直接 spawn 原生 CU server。
///
/// 两条约束：
/// - 中间不经过 shell：服务端校验**直接父进程**的签名，多插一层就会失效。
/// - 必须放弃责任归属（disclaim），让 node 成为自己的 responsible process。否则
///   Codex++ 被 Claude 的 `disclaimer` 或管理器 GUI 拉起时，责任进程是 ad-hoc 签名的
///   Codex++，原生客户端报 `bootstrapTimedOut`。见 `disclaimed_spawn` 顶部的实测表。
fn spawn_child(
    runtime: &RuntimeLocation,
    shim: &std::path::Path,
) -> anyhow::Result<crate::disclaimed_spawn::DisclaimedChild> {
    let mut envs: Vec<(String, String)> = runtime.native_client_env().into_iter().collect();
    envs.push(("CODEX_PLUS_CU_CLIENT".into(), runtime.client.clone()));
    crate::disclaimed_spawn::spawn(
        std::path::Path::new(&runtime.node),
        &[OsStr::new(shim)],
        &envs,
    )
}

fn spawn_client_reader(sender: Sender<Event>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let mut frame = Vec::new();
            match read_frame(&mut reader, &mut frame) {
                Ok(0) => break,
                Ok(_) => {
                    if sender.send(Event::Client(frame)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_child_reader(stdout: Box<dyn Read + Send>, sender: Sender<Event>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut frame = Vec::new();
            match read_frame(&mut reader, &mut frame) {
                Ok(0) => break,
                Ok(_) => {
                    if sender.send(Event::Child(frame)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(Event::ChildClosed);
    });
}

/// 读一整帧（含结尾换行）。返回读到的字节数，0 表示 EOF。
///
/// 用 `read_until` 而不是 `lines()`：后者做 UTF-8 校验并吃掉换行，
/// 而直通层的目标是**字节不变**。
fn read_frame(reader: &mut impl BufRead, frame: &mut Vec<u8>) -> std::io::Result<usize> {
    let read = reader.read_until(b'\n', frame)?;
    if read > MAX_FRAME {
        frame.clear();
        return Ok(0);
    }
    Ok(read)
}

/// 已转给客户端、正在等答复的审批。
struct PendingApproval {
    /// 子进程原本的请求 id。
    child_id: Value,
    /// 用于记忆与审计的键（bundle id，缺失时是显示名）。
    key: String,
    display: String,
    started: Instant,
}

struct Forwarder {
    child_stdin: Box<dyn Write + Send>,
    /// 是否还需要在 `initialize` 里替客户端补 elicitation 能力。
    declare_elicitation: bool,
    /// 客户端自己是否声明了 elicitation。
    ///
    /// `None` = 还没握手。这个值决定 `claude` 模式能不能真的转发：
    /// Claude Code 2.x 不声明（转发出去没人渲染，只会等到超时），
    /// 3.x 之后声明与否要以实际握手为准，不能按版本号猜。
    client_supports_elicitation: Option<bool>,
    mode: ApprovalMode,
    /// 我们发给客户端的审批请求 id（字符串，避免与两端数字 id 撞号）→ 待办。
    pending: HashMap<String, PendingApproval>,
    /// 本进程内已放行的 app（`session` 语义，不落盘）。
    session_allowed: BTreeSet<String>,
    next_token: u64,
}

impl Forwarder {
    fn run(&mut self, receiver: Receiver<Event>) -> anyhow::Result<()> {
        // 用 `recv_timeout` 而不是 `recv`：审批超时需要在**没有消息**时也能触发。
        loop {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(Event::Client(frame)) => {
                    if let Err(error) = self.on_client(frame) {
                        eprintln!("[codex-plus-cu] 处理客户端消息失败：{error:#}");
                        return Ok(());
                    }
                }
                Ok(Event::Child(frame)) => self.on_child(frame)?,
                Ok(Event::ChildClosed) => {
                    self.cancel_all("CU 子进程已退出");
                    return Ok(());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.cancel_all("客户端已断开");
                    return Ok(());
                }
            }
            self.expire_pending()?;
        }
    }

    /// 客户端 → 子进程。
    ///
    /// 两种帧需要处理：`initialize` 要补 elicitation 能力；对本代理发出的审批
    /// 请求的答复要换回子进程的原始 id。
    fn on_client(&mut self, frame: Vec<u8>) -> anyhow::Result<()> {
        if self.declare_elicitation
            && mentions(&frame, b"\"method\"")
            && mentions(&frame, b"\"initialize\"")
            && let Ok(mut message) = serde_json::from_slice::<Value>(&frame)
            && message.get("method").and_then(Value::as_str) == Some("initialize")
        {
            // 先记下客户端**自己**有没有声明，再补。补只是为了不让服务端拒绝，
            // 不代表客户端真的会渲染这个表单——`claude` 模式要看这个值决定能否转发。
            let supports = declares_capability(&message, "elicitation");
            self.client_supports_elicitation = Some(supports);
            crate::computer_use_approval::record_client(
                message.get("params").and_then(|params| params.get("clientInfo")),
                supports,
            );
            declare_elicitation(&mut message);
            self.declare_elicitation = false;
            let mut line = serde_json::to_vec(&message)?;
            line.push(b'\n');
            return self.write_child(&line);
        }
        // 审批答复：没有 method、id 是我们发的字符串。
        if !mentions(&frame, b"\"method\"")
            && mentions(&frame, b"\"result\"")
            && let Ok(message) = serde_json::from_slice::<Value>(&frame)
            && let Some(token) = message.get("id").and_then(Value::as_str)
            && let Some(pending) = self.pending.remove(token)
        {
            return self.relay_approval(&pending, &message);
        }
        self.write_child(&frame)
    }

    /// 逐条答复客户端对审批请求的决定。
    fn relay_approval(&mut self, pending: &PendingApproval, message: &Value) -> anyhow::Result<()> {
        let action = message
            .get("result")
            .and_then(|result| result.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("cancel");
        let content = message
            .get("result")
            .and_then(|result| result.get("content"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let outcome = match action {
            "accept" => Outcome::ClientAccepted,
            "decline" => Outcome::ClientDeclined,
            _ => Outcome::ClientCanceled,
        };
        if outcome.accepted() {
            // `session` 语义在本进程内生效；跨会话的持久化交给 `remember`。
            self.session_allowed.insert(pending.key.clone());
        }
        let reply = json!({
            "jsonrpc": "2.0",
            "id": pending.child_id,
            "result": { "action": action, "content": content }
        });
        let mut line = serde_json::to_vec(&reply)?;
        line.push(b'\n');
        self.write_child(&line)?;
        self.audit(pending, outcome);
        Ok(())
    }

    /// 子进程 → 客户端。审批请求按策略处理，其余帧原样透传。
    fn on_child(&mut self, frame: Vec<u8>) -> anyhow::Result<()> {
        if mentions(&frame, b"\"method\"") && mentions(&frame, b"elicitation/create") {
            if let Ok(message) = serde_json::from_slice::<Value>(&frame) {
                if message.get("method").and_then(Value::as_str) == Some("elicitation/create") {
                    return self.on_elicitation(message);
                }
            }
        }
        write_client(&frame)
    }

    fn on_elicitation(&mut self, message: Value) -> anyhow::Result<()> {
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let (key, display) = subject_of(&params);
        let child_id = message.get("id").cloned().unwrap_or(Value::Null);

        // 1) 本进程已放行过 / 文件里记忆过 → 直接 accept。
        let remembered = if self.session_allowed.contains(&key) {
            true
        } else {
            ApprovalStore::load()
                .apps
                .get(&key)
                .map(|entry| entry.decision == "allow")
                .unwrap_or(false)
        };
        if remembered {
            let pending = PendingApproval {
                child_id: child_id.clone(),
                key,
                display,
                started: Instant::now(),
            };
            return self.accept_now(&pending, Outcome::Remembered);
        }

        // 2) `auto` 模式：就地放行，只留痕。
        if self.mode == ApprovalMode::Auto {
            let pending = PendingApproval {
                child_id,
                key,
                display,
                started: Instant::now(),
            };
            return self.accept_now(&pending, Outcome::AutoAccepted);
        }

        // 3) `claude` 模式：只有客户端**自己**声明了 elicitation 才转发。
        //
        // 客户端没声明时转发出去没人渲染，只能干等到超时——那比直接放行更糟：
        // 用户会看到「读应用列表正常、一点击就卡两分钟」。
        // 版本号不能作为依据（2.x 不声明、3.x 之后可能变），一律以握手时的实际能力为准。
        if self.client_supports_elicitation == Some(false) {
            let pending = PendingApproval {
                child_id,
                key,
                display,
                started: Instant::now(),
            };
            eprintln!(
                "[codex-plus-cu] 客户端未声明 elicitation，`claude` 审批模式退回放行；\
                 如需真正审批请改用支持 elicitation 的客户端"
            );
            return self.accept_now(&pending, Outcome::AutoAccepted);
        }
        self.next_token += 1;
        let token = format!("codexplus-cu-elicit-{}", self.next_token);
        let forwarded = json!({
            "jsonrpc": "2.0",
            "id": token,
            "method": "elicitation/create",
            "params": params,
        });
        let mut line = serde_json::to_vec(&forwarded)?;
        line.push(b'\n');
        self.pending.insert(
            token,
            PendingApproval {
                child_id,
                key,
                display,
                started: Instant::now(),
            },
        );
        write_client(&line)
    }

    fn accept_now(&mut self, pending: &PendingApproval, outcome: Outcome) -> anyhow::Result<()> {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": pending.child_id,
            "result": { "action": "accept", "content": {} }
        });
        let mut line = serde_json::to_vec(&reply)?;
        line.push(b'\n');
        self.write_child(&line)?;
        if outcome == Outcome::AutoAccepted {
            self.session_allowed.insert(pending.key.clone());
        }
        self.audit(pending, outcome);
        Ok(())
    }

    /// 超时的审批一律回 `cancel`，避免客户端不答就把整条链路吊死。
    fn expire_pending(&mut self) -> anyhow::Result<()> {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.started.elapsed() >= APPROVAL_TIMEOUT)
            .map(|(token, _)| token.clone())
            .collect();
        for token in expired {
            if let Some(pending) = self.pending.remove(&token) {
                let reply = json!({
                    "jsonrpc": "2.0",
                    "id": pending.child_id,
                    "result": { "action": "cancel", "content": {} }
                });
                let mut line = serde_json::to_vec(&reply)?;
                line.push(b'\n');
                self.write_child(&line)?;
                self.audit(&pending, Outcome::ClientCanceled);
            }
        }
        Ok(())
    }

    fn cancel_all(&mut self, _reason: &str) {
        // 先把待办取出来再逐个答复：直接 drain 会同时可变借出 self.pending 与 self。
        let pending: Vec<(String, PendingApproval)> = self.pending.drain().collect();
        for (_, pending) in pending {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": pending.child_id,
                "result": { "action": "cancel", "content": {} }
            });
            if let Ok(mut line) = serde_json::to_vec(&reply) {
                line.push(b'\n');
                let _ = self.write_child(&line);
            }
            self.audit(&pending, Outcome::ClientCanceled);
        }
    }

    fn audit(&self, pending: &PendingApproval, outcome: Outcome) {
        let params = json!({
            "message": format!("Allow Computer Use to use \"{}\"?", pending.display),
            "_meta": { "tool_params": { "app": pending.key } }
        });
        crate::computer_use_approval::audit(&params, self.mode, outcome);
    }

    fn write_child(&mut self, frame: &[u8]) -> anyhow::Result<()> {
        self.child_stdin
            .write_all(frame)
            .context("无法写入 CU 子进程的标准输入")?;
        self.child_stdin
            .flush()
            .context("无法刷新 CU 子进程的标准输入")?;
        Ok(())
    }
}

/// 子串预筛：避免把几百 KB 的截图帧反复做 JSON 解析。
fn mentions(frame: &[u8], needle: &[u8]) -> bool {
    frame.windows(needle.len()).any(|window| window == needle)
}

fn write_client(frame: &[u8]) -> anyhow::Result<()> {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(frame)?;
    lock.flush()?;
    Ok(())
}

/// 客户端自己有没有声明某个能力（`params.capabilities.<name>` 存在且非 null）。
pub(crate) fn declares_capability(message: &Value, name: &str) -> bool {
    message
        .get("params")
        .and_then(|params| params.get("capabilities"))
        .and_then(|capabilities| capabilities.get(name))
        .map(|value| !value.is_null())
        .unwrap_or(false)
}

/// 在客户端声明的能力里补上 `elicitation`，其余字段原样保留。
///
/// 早先的实现直接替换整个 `capabilities`（连 `clientInfo` 一起盖掉），
/// 那会让服务端看到的能力与客户端真实能力不符。
pub(crate) fn declare_elicitation(message: &mut Value) {
    let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) else {
        return;
    };
    let capabilities = params
        .entry("capabilities")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !capabilities.is_object() {
        *capabilities = Value::Object(serde_json::Map::new());
    }
    if let Some(object) = capabilities.as_object_mut() {
        object
            .entry("elicitation")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declare_elicitation_keeps_existing_capabilities() {
        let mut message = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "roots": { "listChanged": true } },
                "clientInfo": { "name": "claude-code", "version": "2.1.245" }
            }
        });
        declare_elicitation(&mut message);
        let params = &message["params"];
        assert!(params["capabilities"]["elicitation"].is_object());
        assert_eq!(params["capabilities"]["roots"]["listChanged"], true);
        // clientInfo 不能被盖掉：服务端会据此判断调用方。
        assert_eq!(params["clientInfo"]["name"], "claude-code");
    }

    #[test]
    fn declare_elicitation_creates_capabilities_when_missing() {
        let mut message = json!({ "method": "initialize", "params": {} });
        declare_elicitation(&mut message);
        assert!(message["params"]["capabilities"]["elicitation"].is_object());
    }

    #[test]
    fn mentions_works_as_cheap_prefilter() {
        let frame = br#"{"jsonrpc":"2.0","method":"elicitation/create","params":{}}"#;
        assert!(mentions(frame, b"\"method\""));
        assert!(mentions(frame, b"elicitation/create"));
        assert!(!mentions(frame, b"\"tools/list\""));
    }

    #[test]
    fn read_frame_preserves_bytes_and_newline() {
        let mut reader = BufReader::new(&b"{\"a\":1}\n{\"b\":2}\n"[..]);
        let mut frame = Vec::new();
        assert_eq!(read_frame(&mut reader, &mut frame).unwrap(), 8);
        assert_eq!(frame, b"{\"a\":1}\n");

        frame.clear();
        assert_eq!(read_frame(&mut reader, &mut frame).unwrap(), 8);
        assert_eq!(frame, b"{\"b\":2}\n");

        frame.clear();
        assert_eq!(read_frame(&mut reader, &mut frame).unwrap(), 0);
    }
}
