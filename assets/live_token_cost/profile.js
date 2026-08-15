"use strict";

api.registerModule("profile", (context) => {
  const ROOT_ID = "codex-live-token-cost-profile-page";
  const STYLE_ID = "codex-live-token-cost-profile-style";
  const LISTENER_COUNT = 1;
  const PROFILE_PLAN_OPTIONS = Object.freeze([
    ["free", "Free"], ["go", "Go"], ["plus", "Plus"], ["pro_5x", "Pro 5x"], ["pro_20x", "Pro 20x"],
    ["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"], ["staff", "Staff"], ["founder", "Founder"],
  ]);
  let root = null;
  let style = null;
  let identityName = null;
  let identityUsername = null;
  let identityEmail = null;
  let identityPlan = null;
  let identityPlanRow = null;
  let editor = null;
  let stopped = false;
  let diagnosticsMounted = false;
  let saveSequence = 0;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function byteLength(value) {
    try { return new TextEncoder().encode(String(value)).length; } catch { return Number.MAX_SAFE_INTEGER; }
  }

  function base64Value(code) {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return -1;
  }

  function validAvatarDataUrl(value) {
    const variants = [
      ["png", "data:image/png;base64,"],
      ["jpeg", "data:image/jpeg;base64,"],
      ["webp", "data:image/webp;base64,"],
    ];
    const variant = variants.find((item) => value.startsWith(item[1]));
    if (!variant || byteLength(value) > 256 * 1024) return false;
    const payload = value.slice(variant[1].length);
    if (!payload || payload.length % 4 !== 0) return false;
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const dataLength = payload.length - padding;
    for (let index = 0; index < dataLength; index += 1) {
      if (base64Value(payload.charCodeAt(index)) < 0) return false;
    }
    for (let index = dataLength; index < payload.length; index += 1) {
      if (payload.charCodeAt(index) !== 61) return false;
    }
    if (padding === 1 && (base64Value(payload.charCodeAt(payload.length - 2)) & 3) !== 0) return false;
    if (padding === 2 && (base64Value(payload.charCodeAt(payload.length - 3)) & 15) !== 0) return false;

    const bytes = [];
    for (let index = 0; index < payload.length && bytes.length < 12; index += 4) {
      const first = base64Value(payload.charCodeAt(index));
      const second = base64Value(payload.charCodeAt(index + 1));
      const third = payload[index + 2] === "=" ? 0 : base64Value(payload.charCodeAt(index + 2));
      const fourth = payload[index + 3] === "=" ? 0 : base64Value(payload.charCodeAt(index + 3));
      bytes.push(((first << 2) | (second >> 4)) & 255);
      if (payload[index + 2] !== "=") bytes.push(((second << 4) | (third >> 2)) & 255);
      if (payload[index + 3] !== "=") bytes.push(((third << 6) | fourth) & 255);
    }
    if (variant[0] === "png") return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    if (variant[0] === "jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return bytes.length >= 12 && bytes.slice(0, 4).every((byte, index) => byte === [82, 73, 70, 70][index])
      && bytes.slice(8, 12).every((byte, index) => byte === [87, 69, 66, 80][index]);
  }

  function formatCount(value) {
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
    return String(value);
  }

  function profileValue() {
    return context.config?.profile || {};
  }

  function setError(message) {
    const previous = root?.querySelector(".cltc-profile-error");
    if (previous) previous.remove();
    if (editor) editor.appendChild(make("div", "cltc-profile-error", String(message || "保存失败，请重试。").slice(0, 180)));
  }

  function clearError() {
    root?.querySelector(".cltc-profile-error")?.remove();
  }

  function avatarText(profile) {
    const value = String(profile.display_name || profile.username || "U").trim();
    return value ? value.slice(0, 1).toUpperCase() : "U";
  }

  function applyIdentity(profile) {
    if (!root) return;
    identityName.textContent = profile.display_name || "Local Usage";
    identityUsername.textContent = `@${profile.username || "local-usage"}`;
    identityEmail.textContent = profile.email || "";
    const plan = profile.plan_label || profile.plan_type || "";
    identityPlan.textContent = plan;
    identityPlanRow.textContent = `Codex ${plan}`.trim();
    const avatar = root.querySelector(".cltc-profile-avatar");
    if (avatar) {
      const image = typeof profile.avatar_data_url === "string" ? profile.avatar_data_url : "";
      avatar.textContent = image ? "" : avatarText(profile);
      avatar.style.setProperty("background-image", image ? `url("${image}")` : "none");
      avatar.style.setProperty("background-size", image ? "cover" : "auto");
      avatar.dataset.hasAvatar = String(Boolean(image));
    }
  }

  function field(label, name, value) {
    const wrap = make("label", "cltc-profile-field");
    wrap.appendChild(make("span", "", label));
    const input = make("input", "cltc-profile-input");
    input.type = "text";
    input.value = value == null ? "" : String(value);
    input.dataset.profileField = name;
    wrap.appendChild(input);
    return wrap;
  }

  function renderEditor() {
    if (!root || editor) return;
    const profile = profileValue();
    editor = make("section", "cltc-profile-editor");
    editor.append(
      make("h2", "", "编辑个人资料"),
      field("显示名称", "display_name", profile.display_name),
      field("用户名", "username", profile.username),
      field("电子邮箱", "email", profile.email),
      field("订阅计划", "plan_label", profile.plan_label),
      field("头像 data URL", "avatar_data_url", profile.avatar_data_url),
    );
    const actions = make("div", "cltc-profile-actions");
    const cancel = make("button", "cltc-profile-button", "取消");
    cancel.type = "button";
    cancel.dataset.profileAction = "cancel";
    const save = make("button", "cltc-profile-button cltc-profile-primary", "保存");
    save.type = "button";
    save.dataset.profileAction = "save";
    actions.append(cancel, save);
    editor.appendChild(actions);
    root.appendChild(editor);
    root.querySelector("[data-profile-field='display_name']")?.focus();
  }

  function validProfile(profile) {
    return byteLength(profile.display_name) <= 128
      && byteLength(profile.username) >= 3 && byteLength(profile.username) <= 20
      && /^[A-Za-z0-9._-]+$/.test(profile.username)
      && byteLength(profile.email) <= 320
      && byteLength(profile.plan_type) <= 128 && byteLength(profile.plan_label) <= 128
      && byteLength(profile.workspace_name) <= 128
      && (profile.avatar_data_url == null || validAvatarDataUrl(profile.avatar_data_url));
  }

  function normalizePlan(value) {
    const custom = String(value || "").trim();
    if (!custom) return null;
    const normalized = custom.toLowerCase();
    return PROFILE_PLAN_OPTIONS.find(([type, label]) => type.toLowerCase() === normalized || label.toLowerCase() === normalized)
      || [custom, custom];
  }

  function saveProfile() {
    if (!editor || stopped) return;
    const previous = profileValue();
    const value = (name) => editor.querySelector(`[data-profile-field='${name}']`).value;
    const plan = normalizePlan(value("plan_label"));
    if (!plan) {
      setError("个人资料格式无效。");
      return;
    }
    const profile = {
      display_name: value("display_name"), username: value("username"), email: value("email"),
      plan_type: plan[0], plan_label: plan[1],
      workspace_name: previous.workspace_name || "", avatar_data_url: value("avatar_data_url") || null,
    };
    if (!validProfile(profile)) {
      setError("个人资料格式无效。");
      return;
    }
    const sequence = ++saveSequence;
    clearError();
    context.emitAction({ type: "save_profile", profile }).then((result) => {
      if (stopped || sequence !== saveSequence) return;
      if (result?.status !== "ok" || result.response?.type !== "updated") throw new Error("profile rejected");
      applyIdentity(context.config.profile);
      editor.remove();
      editor = null;
    }).catch(() => {
      if (!stopped && sequence === saveSequence) setError("保存失败，请重试。");
    });
  }

  function onClick(event) {
    const tab = event.target?.closest?.("[data-profile-tab]")?.dataset.profileTab;
    if (["个人资料", "数据控制"].includes(tab)) {
      for (const item of root.querySelectorAll("[data-profile-tab]")) item.dataset.active = String(item.dataset.profileTab === tab);
      const card = root.querySelector(".profile-card");
      const activity = root.querySelector(".cltc-profile-activity");
      if (card) card.hidden = tab !== "个人资料";
      if (activity) activity.hidden = tab !== "数据控制";
      return;
    }
    const action = event.target?.closest?.("[data-profile-action]")?.dataset.profileAction;
    if (action === "close") context.close();
    else if (action === "edit") renderEditor();
    else if (action === "cancel") {
      editor?.remove();
      editor = null;
    } else if (action === "save") saveProfile();
  }

  function mount() {
    const target = context.mountTarget;
    if (stopped || root || !target?.isConnected) return;
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    style = make("style");
    style.id = STYLE_ID;
    style.textContent = `
      main:has(> #${ROOT_ID}){position:relative!important;overflow:hidden!important}
      #${ROOT_ID}{--profile-bg:var(--color-token-main-surface-primary,light-dark(#fff,#18181b));--profile-panel:var(--color-token-main-surface-secondary,light-dark(#f7f7f8,#242426));--profile-text:var(--color-token-text-primary,light-dark(#111827,#f4f4f5));--profile-muted:var(--color-token-text-tertiary,light-dark(#6b7280,#a1a1aa));--profile-border:var(--color-token-border-light,light-dark(#e5e7eb,#34343a));position:absolute;inset:0;z-index:2147483646;box-sizing:border-box;overflow:auto;background:var(--profile-bg);color:var(--profile-text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
      #${ROOT_ID} .cltc-profile-shell{position:relative;width:min(940px,calc(100% - 64px));margin:0 auto;padding:64px 0 48px}
      #${ROOT_ID} button{font:inherit}#${ROOT_ID} .cltc-profile-close{position:absolute;top:60px;right:0;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--profile-muted);cursor:pointer;font-size:20px;opacity:.55}
      #${ROOT_ID} .cltc-profile-tabs{display:flex;gap:28px;margin:0 0 36px;border-bottom:1px solid var(--profile-border)}
      #${ROOT_ID} .cltc-profile-tab{min-height:42px;padding:9px 16px 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--profile-muted);font-size:14px;cursor:default}
      #${ROOT_ID} .cltc-profile-tab[data-active='true']{border-bottom-color:var(--profile-text);color:var(--profile-text);font-weight:600}
      #${ROOT_ID} .profile-card{display:grid;gap:0;border:1px solid var(--profile-border);border-radius:8px;background:var(--profile-bg);overflow:hidden}#${ROOT_ID} .profile-card[hidden],#${ROOT_ID} .cltc-profile-activity[hidden]{display:none}
      #${ROOT_ID} .cltc-profile-identity{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:28px;min-height:126px;box-sizing:border-box;padding:28px}
      #${ROOT_ID} .cltc-profile-avatar{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border:0;border-radius:50%;background:light-dark(#dbeafe,#263b5e);color:light-dark(#1d4ed8,#bfdbfe);cursor:pointer;font-size:24px;font-weight:500}
      #${ROOT_ID} .cltc-profile-name{font-size:20px;font-weight:500}#${ROOT_ID} .cltc-profile-username{margin-top:4px;color:var(--profile-muted);font-size:14px}
      #${ROOT_ID} .cltc-profile-plan{padding:5px 10px;border:1px solid light-dark(#a7f3d0,#166534);border-radius:999px;background:light-dark(#ecfdf5,#102c20);color:light-dark(#166534,#86efac);font-size:12px}
      #${ROOT_ID} .cltc-profile-row{display:grid;grid-template-columns:160px minmax(0,1fr);align-items:center;gap:0;min-height:57px;box-sizing:border-box;padding:16px 28px;border-top:1px solid var(--profile-border)}
      #${ROOT_ID} .cltc-profile-row span{color:var(--profile-muted);font-size:14px}#${ROOT_ID} .cltc-profile-row strong{font-size:14px;font-weight:400}
      #${ROOT_ID} .cltc-profile-activity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}
      #${ROOT_ID} .cltc-profile-stat{display:grid;gap:4px;padding:16px;border:1px solid var(--profile-border);border-radius:8px}#${ROOT_ID} .cltc-profile-stat span{color:var(--profile-muted);font-size:12px}#${ROOT_ID} .cltc-profile-stat strong{font-size:18px}
      #${ROOT_ID} .cltc-profile-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px;padding:18px;border:1px solid var(--profile-border);border-radius:8px;background:var(--profile-panel)}
      #${ROOT_ID} .cltc-profile-editor h2,#${ROOT_ID} .cltc-profile-actions,#${ROOT_ID} .cltc-profile-error{grid-column:1/-1;margin:0}
      #${ROOT_ID} .cltc-profile-editor h2{font-size:15px}#${ROOT_ID} .cltc-profile-field{display:grid;gap:6px}#${ROOT_ID} .cltc-profile-field span{color:var(--profile-muted);font-size:12px}
      #${ROOT_ID} .cltc-profile-input{box-sizing:border-box;width:100%;height:36px;padding:7px 10px;border:1px solid var(--profile-border);border-radius:8px;background:var(--profile-bg);color:var(--profile-text);font:inherit;outline:none}
      #${ROOT_ID} .cltc-profile-actions{display:flex;justify-content:flex-end;gap:8px}#${ROOT_ID} .cltc-profile-button{min-height:32px;padding:6px 11px;border:1px solid var(--profile-border);border-radius:8px;background:transparent;color:inherit;cursor:pointer}#${ROOT_ID} .cltc-profile-primary{background:var(--profile-text);color:var(--profile-bg)}
      #${ROOT_ID} .cltc-profile-error{color:light-dark(#b42318,#f97066);font-size:12px}
      @media(max-width:620px){#${ROOT_ID} .cltc-profile-shell{width:min(calc(100% - 32px),940px);padding-top:32px}#${ROOT_ID} .cltc-profile-close{top:28px}#${ROOT_ID} .cltc-profile-identity{grid-template-columns:auto minmax(0,1fr);gap:16px;padding:20px}#${ROOT_ID} .cltc-profile-plan{grid-column:2}#${ROOT_ID} .cltc-profile-row{grid-template-columns:minmax(0,1fr);gap:4px;padding:14px 20px}#${ROOT_ID} .cltc-profile-editor{grid-template-columns:minmax(0,1fr)}}
    `;
    document.head.appendChild(style);
    root = make("section", "cltc-profile-page");
    root.id = ROOT_ID;
    const shell = make("div", "cltc-profile-shell");
    const close = make("button", "cltc-profile-close", "×");
    close.type = "button";
    close.dataset.profileAction = "close";
    close.setAttribute("aria-label", "关闭");
    shell.appendChild(close);
    const tabs = make("nav", "cltc-profile-tabs");
    for (const label of ["个人资料", "通知", "数据控制"]) {
      const tab = make("button", "cltc-profile-tab", label);
      tab.type = "button";
      tab.dataset.profileTab = label;
      tab.dataset.active = String(label === "个人资料");
      tabs.appendChild(tab);
    }
    shell.appendChild(tabs);
    const profile = profileValue();
    const card = make("section", "profile-card");
    const identity = make("div", "cltc-profile-identity");
    const avatar = make("button", "cltc-profile-avatar", avatarText(profile));
    avatar.type = "button";
    avatar.dataset.profileAction = "edit";
    avatar.setAttribute("aria-label", "编辑个人资料");
    const labels = make("div", "cltc-profile-labels");
    identityName = make("div", "cltc-profile-name");
    identityUsername = make("div", "cltc-profile-username");
    labels.append(identityName, identityUsername);
    identityPlan = make("span", "cltc-profile-plan");
    identity.append(avatar, labels, identityPlan);
    card.appendChild(identity);
    const emailRow = make("div", "cltc-profile-row");
    identityEmail = make("strong");
    emailRow.append(make("span", "", "电子邮箱"), identityEmail);
    const planRow = make("div", "cltc-profile-row");
    identityPlanRow = make("strong");
    planRow.append(make("span", "", "订阅计划"), identityPlanRow);
    card.append(emailRow, planRow);
    shell.appendChild(card);
    const snapshot = context.snapshot;
    const activity = make("section", "cltc-profile-activity");
    const turns = make("div", "cltc-profile-stat");
    turns.append(make("span", "", "模型调用"), make("strong", "", formatCount(snapshot?.turns || 0)));
    const tokens = make("div", "cltc-profile-stat");
    tokens.append(make("span", "", "总 Token"), make("strong", "", formatCount((snapshot?.input || 0) + (snapshot?.output || 0))));
    activity.append(turns, tokens);
    activity.hidden = true;
    shell.appendChild(activity);
    root.appendChild(shell);
    root.addEventListener("click", onClick);
    target.appendChild(root);
    applyIdentity(profile);
    close.focus();
    context.recordDomWrite(2);
    context.recordListenerDelta(LISTENER_COUNT);
    diagnosticsMounted = true;
  }

  function unmount() {
    if (stopped) return;
    stopped = true;
    saveSequence += 1;
    root?.removeEventListener("click", onClick);
    root?.remove();
    style?.remove();
    if (diagnosticsMounted) {
      context.recordDomWrite(2);
      context.recordListenerDelta(-LISTENER_COUNT);
      diagnosticsMounted = false;
    }
    root = null;
    style = null;
    editor = null;
  }

  return Object.freeze({ mount, unmount });
});
