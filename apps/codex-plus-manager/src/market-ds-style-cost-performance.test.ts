import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptPath = new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url);
const zhcnScriptPath = new URL("../../../assets/user_scripts/market-codex-zhcn-translate.js", import.meta.url);

async function readScript() {
  return readFile(scriptPath, "utf8");
}

function functionBody(source: string, name: string, nextName: string) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`\n\n  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should be present before ${nextName}`);
  return source.slice(start, end);
}

test("HUD keeps a fixed non-scrolling layout with wider LLM and tool columns", async () => {
  const source = await readScript();
  const style = functionBody(source, "ensureStyle", "ensureRoot");
  const rootRule = style.match(/#\$\{ROOT_ID\} \{([\s\S]*?)\n      \}/)?.[1] || "";
  assert.ok(rootRule, "HUD root style should be present");

  assert.match(
    style,
    /grid-template-columns: minmax\(0, \.95fr\) minmax\(0, 1\.35fr\) minmax\(0, 1\.3fr\) minmax\(0, \.9fr\) minmax\(0, 1\.3fr\)/,
  );
  assert.match(
    style,
    /data-cltc-output-rate-visible="true"[^`]*grid-template-columns: minmax\(0, \.95fr\) minmax\(0, 1\.35fr\) minmax\(0, 1\.45fr\) minmax\(0, \.9fr\) minmax\(0, 1\.3fr\)/,
  );
  assert.match(rootRule, /height: 61px;/);
  assert.match(rootRule, /margin: 0 auto -18px;/);
  assert.match(rootRule, /padding: 8px 10px 25px;/);
  assert.doesNotMatch(style, /minmax\(260px,\s*2\.05fr\)/);
  assert.match(rootRule, /border: 0;/);
  assert.match(rootRule, /border-radius: var\(--cltc-arc-radius\) var\(--cltc-arc-radius\) 0 0;/);
  assert.match(rootRule, /z-index: 0;/);
  assert.doesNotMatch(style, /overscroll-behavior-x:\s*contain/);
  assert.doesNotMatch(source, /cltc-cadenced-shimmer|cltc-roll-digit-column|cltc-roll-digit-stack/);
  assert.doesNotMatch(source, /stopCadencedShimmer|syncCadencedShimmer/);
});

test("HUD restores the composer-integrated visual footprint", async () => {
  const source = await readScript();
  const style = functionBody(source, "ensureStyle", "ensureRoot");

  assert.match(style, /height: 61px;/);
  assert.match(style, /margin: 0 auto -18px;/);
  assert.match(style, /padding: 8px 10px 25px;/);
});

test("HUD caches value slots and only writes changed text", async () => {
  const source = await readScript();
  const updateValue = functionBody(source, "updateValueSlot", "updateHubContent");

  assert.match(source, /hubValueSlots:\s*new Map\(\)/);
  assert.match(source, /function cacheHubValueSlots\(root\)/);
  assert.match(source, /cacheHubValueSlots\(root\)/);
  assert.match(updateValue, /state\.hubValueSlots\.get\(key\)/);
  assert.doesNotMatch(updateValue, /querySelectorAll/);
});

test("sidebar chat selection resolves the active session before usage arrives", async () => {
  const source = await readScript();
  const activeSidebar = functionBody(source, "activeSidebarThreadKey", "hasActiveSidebarThreadDom");
  const activeDom = functionBody(source, "hasActiveSidebarThreadDom", "sidebarThreadKeyFromNode");
  const sidebarClick = functionBody(source, "rememberSidebarThreadClick", "rememberNewConversationClick");
  const pointerDown = functionBody(source, "handleDocumentPointerDown", "installLocalFetchCapture");

  assert.match(activeSidebar, /data-app-action-sidebar-thread-selected='true'/);
  assert.match(activeDom, /data-app-action-sidebar-thread-selected='true'/);
  assert.match(sidebarClick, /event\?\.type !== \"click\" && event\?\.type !== \"pointerdown\"/);
  assert.match(pointerDown, /rememberSidebarThreadClick\(event\)/);
  assert.ok(activeSidebar.indexOf("const recentClickedKey") < activeSidebar.indexOf("const selectors"));
});

test("side chat bridge streams contribute rounds and steps without fake token usage", async () => {
  const source = await readScript();
  const identity = functionBody(source, "extractSessionIdentity", "extractSessionInfo");
  const sideRoot = functionBody(source, "sideChatRoot", "sideChatDomTurns");
  const sideChat = functionBody(source, "sideChatDomTurns", "activeSidebarThreadKey");
  const startupBlank = functionBody(source, "startupBlankConversationSessionKey", "startupResetSessionKey");
  const inspect = functionBody(source, "inspectLocalPayload", "localUsageExport");
  const snapshot = functionBody(source, "liveSnapshot", "emptyDailyUsageBucket");

  assert.match(identity, /extractJsonFragmentsFromSse\(value\)/);
  assert.match(sideRoot, /data-quick-chat-thread-scroll-content/);
  assert.match(sideChat, /data-chatgpt-conversation-turn="true"/);
  assert.match(startupBlank, /sideChatRoot\(doc\)/);
  assert.match(inspect, /observeSideChatStreamPayload\((?:payload|inspectedPayload), source, sessionKey\)/);
  assert.match(snapshot, /sideChatDomTurns\(document, sessionKey\)/);
  assert.match(snapshot, /sessionPerformance\(displayTurns, currentTurn\)/);
  assert.doesNotMatch(inspect, /persistLocalCurrentTurn\(.*sideChat/);
});

test("network capture filters unrelated payloads before deep parsing", async () => {
  const source = await readScript();
  assert.match(source, /function shouldInspectCapturedPayload\(/);
  assert.match(source, /if \(!shouldInspectCapturedPayload\(event\?\.data, "message"\)\) return;/);
  assert.match(source, /if \(!shouldInspectCapturedPayload\(event\.data, "websocket", \{ url \}\)\) return;/);
  assert.match(source, /if \(isCodexApi && shouldInspectCapturedPayload\(args\[0\], "xhr-body", \{ url \}\)\)/);
  assert.match(source, /if \(!shouldInspectCapturedPayload\(this\.responseText \|\| "", "xhr", \{ url: this\.__codexLiveTokenCostUrl \}\)\) return;/);
});

test("network capture bounds payload work and requires a metric marker", async () => {
  const source = await readScript();
  const captureGate = functionBody(source, "shouldInspectCapturedPayload", "isProfileUsageUrl");

  assert.match(source, /const CAPTURE_MAX_PAYLOAD_LENGTH = 262144;/);
  assert.match(source, /function capturedPayloadHasMetricMarker\(/);
  assert.match(captureGate, /if \(isCodexApiUrl\(url\)\) return capturedPayloadHasMetricMarker\(payload/);
  assert.doesNotMatch(captureGate, /if \(isCodexApiUrl\(url\)\) return true;/);
});

test("network capture skips streaming and oversized response clones", async () => {
  const source = await readScript();
  const responseGate = functionBody(source, "shouldCaptureCodexResponseBody", "isProfileUsageUrl");

  assert.match(responseGate, /event-stream/);
  assert.match(responseGate, /const isJson =/);
  assert.match(responseGate, /CAPTURE_MAX_PAYLOAD_LENGTH/);
  assert.match(source, /shouldCaptureCodexResponseBody\(response, url\)/);
});

test("message capture ignores bridge responses without usage or stream markers", async () => {
  const source = await readScript();
  const captureGate = functionBody(source, "shouldInspectCapturedPayload", "isProfileUsageUrl");

  assert.match(captureGate, /payload\?\.type === "fetch-response"/);
  assert.match(captureGate, /capturedPayloadHasMetricMarker/);
  assert.doesNotMatch(captureGate, /payload\?\.type === "fetch-response"\) return true/);
});

test("profile auth stack inspection is gated to visible profile UI", async () => {
  const source = await readScript();
  const authPatch = functionBody(source, "patchProfileReactAuthContext", "isSettingsSectionsArray");

  assert.match(source, /const PROFILE_UI_AUTH_GATE_TTL_MS = 500;/);
  assert.match(source, /function profileUiAuthReadGateActive\(/);
  assert.match(authPatch, /profileUiAuthReadGateActive\(\)\s*&&\s*isProfileUiAuthRead\(new Error\(\)\.stack/);
});

test("profile unlock is opt-in and does not patch the renderer by default", async () => {
  const source = await readScript();
  const profileToggle = functionBody(source, "profileUnlockEnabled", "saveProfileUnlockEnabled");

  assert.match(profileToggle, /localStorage\.getItem\(PROFILE_UNLOCK_ENABLED_KEY\) === "true"/);
  assert.match(profileToggle, /catch \{\s*return false;/);
});

test("Chinese translation observes only structural UI mutations", async () => {
  const source = await readFile(zhcnScriptPath, "utf8");
  const install = source.slice(source.indexOf("  function install()"));

  assert.match(source, /function mutationTouchesReasoningUi\(/);
  assert.match(source, /function shouldTranslateAddedNode\(/);
  assert.match(install, /if \(!mutationTouchesTranslationUi\(mutation\)\) continue;/);
  assert.match(install, /mutationTouchesReasoningUi\(mutation\)/);
  assert.match(install, /scheduleReasoningSync\(\);/);
  assert.match(install, /structuralObserver\.observe\(root, \{[\s\S]*childList: true[\s\S]*subtree: true/);
  assert.match(install, /reasoningObserver\.observe\(reasoningRoot, \{[\s\S]*attributes: true/);
  assert.doesNotMatch(install, /structuralObserver\.observe\(root, \{[\s\S]*attributes: true/);
  assert.doesNotMatch(install, /characterData:\s*true/);
});

test("mutation observers stop discovery work and ignore non-turn side-chat mutations", async () => {
  const source = await readScript();
  const modelObserver = functionBody(source, "installOfficialModelObserver", "localProfileResponse");
  const sideObserver = functionBody(source, "syncSideChatObserver", "render");

  assert.match(modelObserver, /state\.officialModelRootObserver\?\.disconnect\?\.\(\)/);
  assert.match(modelObserver, /if \(state\.officialModelTrigger\?\.isConnected\) \{/);
  assert.match(source, /function mutationTouchesHubVisibility\(/);
  assert.match(source, /function mutationTouchesProfileIdentity\(/);
  assert.match(source, /if \(mutations\.some\(mutationTouchesProfileIdentity\)\) scheduleSidebarProfileIdentitySync\(80\)/);
  assert.match(source, /function mutationTouchesSideChatTurn\(/);
  assert.match(sideObserver, /new MutationObserver\(\(mutations\) => \{/);
  assert.match(sideObserver, /if \(!Array\.from\(mutations\)\.some\(mutationTouchesSideChatTurn\)\) return;/);
});

test("profile ledger writes coalesce and completed turns flush immediately", async () => {
  const source = await readScript();
  const upsert = functionBody(source, "profileLedgerUpsertTurn", "profileLedgerObserveLocalTurn");
  const observe = functionBody(source, "profileLedgerObserveLocalTurn", "loadDefaultPrices");

  assert.match(source, /const PROFILE_LEDGER_WRITE_COALESCE_MS = 500;/);
  assert.match(source, /profileLedgerPendingTurns:\s*new Map\(\)/);
  assert.match(source, /function scheduleProfileLedgerWrite\(/);
  assert.match(source, /function flushProfileLedgerWrites\(/);
  assert.match(source, /const turns = Array\.from\(state\.profileLedgerPendingTurns\.values\(\)\)/);
  assert.match(source, /turns\.forEach\(\(turn\) => tx\.objectStore\(PROFILE_LEDGER_STORE_TURNS\)\.put\(turn\)\)/);
  assert.match(upsert, /scheduleProfileLedgerWrite\(merged, options\.calls, options\.invocations/);
  assert.match(upsert, /if \(options\.flush\) flushProfileLedgerWrites\(\);/);
  assert.match(observe, /scheduleProfileLedgerWrite\(merged, calls, invocations/);
  assert.match(observe, /flushProfileLedgerWrites\(\);/);
});
