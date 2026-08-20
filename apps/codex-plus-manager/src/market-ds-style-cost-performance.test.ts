import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const scriptPath = new URL("../../../assets/user_scripts/market-codex-ds-style-cost.js", import.meta.url);
const zhcnScriptPath = new URL("../../../assets/user_scripts/market-codex-zhcn-translate.js", import.meta.url);
const helperPath = new URL("../../../scripts/codex-local-usage-helper.cjs", import.meta.url);
const helperLauncherPath = new URL("../../../scripts/start-helper.sh", import.meta.url);

async function readScript() {
  return readFile(scriptPath, "utf8");
}

function functionBody(source: string, name: string, nextName: string) {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const startMatch = normalizedSource.match(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  const start = startMatch?.index ?? -1;
  const endMatch = start >= 0
    ? normalizedSource.slice(start).match(new RegExp(`\\n\\n  (?:async )?function ${nextName}\\(`))
    : null;
  const end = endMatch?.index != null ? start + endMatch.index : -1;
  assert.ok(start >= 0 && end > start, `${name} should be present before ${nextName}`);
  return normalizedSource.slice(start, end);
}

test("function body extraction accepts CRLF source", async () => {
  const source = await readScript();
  const crlfSource = source.replace(/\r?\n/g, "\r\n");
  const style = functionBody(crlfSource, "ensureStyle", "ensureRoot");

  assert.match(style, /function ensureStyle\(\)/);
});

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

test("profile unlock defaults on and schedules the full unlock after app boot", async () => {
  const source = await readScript();
  const profileToggle = functionBody(source, "profileUnlockEnabled", "saveProfileUnlockEnabled");
  const startup = functionBody(source, "start", "scheduleStart");
  const scheduler = functionBody(source, "scheduleProfileUnlockInstall", "uninstallOfficialProfileUnlock");
  const toggle = functionBody(source, "setProfileUnlockEnabled", "findComposerBox");

  assert.match(profileToggle, /localStorage\.getItem\(PROFILE_UNLOCK_ENABLED_KEY\) !== "false"/);
  assert.match(profileToggle, /catch \{\s*return true;/);
  assert.doesNotMatch(source, /installProfileUnlockOnDemand/);
  assert.match(startup, /scheduleProfileUnlockInstall\(\);/);
  assert.match(source, /scheduleProfileUnlockInstall\(\);\s+scheduleStart\(\);/);
  assert.doesNotMatch(startup, /installOfficialProfileUnlock\(\)/);
  assert.match(scheduler, /new MutationObserver/);
  assert.match(scheduler, /appShellRendered\(\)/);
  assert.match(scheduler, /window\.setTimeout\(\(\) => \{\s*observer\?\.disconnect\?\.\(\);\s*install\(\);\s*\}, 15000\)/);
  assert.match(scheduler, /installOfficialProfileUnlock\(\);/);
  assert.match(scheduler, /scheduleProfileUsageRefresh\(0\);/);
  assert.match(toggle, /installOfficialProfileUnlock\(\);/);
  assert.match(toggle, /scheduleProfileUsageRefresh\(0\);/);
});

test("profile unlock patches the settings sections filter and restores it on disable", async () => {
  const source = await readScript();
  const install = functionBody(source, "installOfficialProfileUnlock", "uninstallOfficialProfileUnlock");
  const uninstall = functionBody(source, "uninstallOfficialProfileUnlock", "setProfileUnlockEnabled");

  assert.match(install, /Array\.prototype\.filter = patchedFilter;/);
  assert.match(install, /isSettingsSectionsArray\(this\) \? profileUnlockedSettingsSections/);
  assert.match(install, /installSidebarProfileIdentitySync\(\);/);
  assert.match(install, /patchProfileStatsigGate\(\);/);
  assert.match(uninstall, /Array\.prototype\.filter = Array\.prototype\.__codexLiveTokenCostOriginalFilter;/);
  assert.match(uninstall, /Promise\.prototype\.then = Promise\.prototype\.__codexLiveTokenCostOriginalThen;/);
  assert.match(uninstall, /RegExp\.prototype\.test = RegExp\.prototype\.__codexLiveTokenCostOriginalTest;/);
});

test("profile request patch serves local data and spoofs the accounts check", async () => {
  const source = await readScript();
  const requestPatch = functionBody(source, "patchProfileRequestClient", "patchProfilePhotoUploadClient");

  assert.match(source, /function spoofProfileAccountsCheckPayload\(/);
  assert.match(requestPatch, /client\.safeGet = async function codexLiveTokenCostProfileSafeGet/);
  assert.match(requestPatch, /if \(profileUnlockEnabled\(\) && isProfileUsageUrl\(url\)\) return profileFetchBodyAsync\("GET", null, url\);/);
  assert.match(requestPatch, /spoofProfileAccountsCheckPayload\(response\)/);
  assert.match(requestPatch, /client\.safePatch = async function codexLiveTokenCostProfileSafePatch/);
});

test("profile request patch discovers the official client from the request module", async () => {
  const source = await readScript();
  const requestPatch = functionBody(source, "installProfileRequestClientPatch", "installProfilePhotoUploadPatch");

  assert.match(requestPatch, /loadCodexAppModule\("request-"\)/);
  assert.match(requestPatch, /module\?\.Fct \? \[module\.Fct\] : Object\.values\(module \|\| \{\}\)/);
  assert.match(requestPatch, /for \(const delay of \[0, 200, 700, 1500\]\)/);
});

test("profile identity sync re-runs when profile UI mutates", async () => {
  const source = await readScript();
  const install = functionBody(source, "installSidebarProfileIdentitySync", "stopSidebarProfileIdentitySync");

  assert.match(install, /new MutationObserver/);
  assert.match(install, /scheduleSidebarProfileIdentitySync\(80\)/);
  assert.match(source, /function mutationTouchesProfileIdentity\(/);
  assert.match(source, /scheduleSidebarProfileIdentitySync\(0\);/);
});

test("profile avatar persists to IndexedDB instead of localStorage", async () => {
  const source = await readScript();
  const save = functionBody(source, "saveLocalProfilePrefs", "extractProfilePhotoDataUrl");
  const load = functionBody(source, "localProfilePrefs", "persistProfileImageAsset");
  const ensure = functionBody(source, "ensureProfileLedgerLoaded", "profileRollupDay");

  assert.match(source, /const PROFILE_LEDGER_DB_VERSION = 3;/);
  assert.match(source, /const PROFILE_LEDGER_STORE_ASSETS = "profileAssets";/);
  assert.match(source, /db\.createObjectStore\(PROFILE_LEDGER_STORE_ASSETS, \{ keyPath: "id" \}\)/);
  assert.match(source, /db\.onversionchange = \(\) => \{/);
  assert.match(source, /request\.onblocked = \(\) => \{/);
  assert.match(source, /function profileAssetPut\(/);
  assert.match(source, /function profileAssetDelete\(/);
  assert.match(save, /imageUrl: next\.imageUrl \? PROFILE_IMAGE_ASSET_REF : null/);
  assert.match(save, /persistProfileImageAsset\(next\.imageUrl\);/);
  assert.match(load, /saved\.imageUrl === PROFILE_IMAGE_ASSET_REF \? "" : normalizeText/);
  assert.match(ensure, /hydrateProfileImageAsset\(\);/);
});

test("local ledger persist strips invocation payloads but keeps skill counts", async () => {
  const source = await readScript();
  const save = functionBody(source, "saveLocalLedger", "normalizedDurationMs");
  const activity = functionBody(source, "localProfileActivityStats", "normalizeHelperStatsPayload");

  assert.match(source, /function slimLocalTurnForPersist\(/);
  assert.match(save, /turns: state\.localLedger\.map\(slimLocalTurnForPersist\)/);
  assert.match(source, /const item = summary\[key\] \|\| \{ invocation, count: 0 \};/);
  assert.match(source, /slim\.invocationSummary = summary;/);
  assert.match(activity, /turn\?\.invocationSummary/);
  assert.match(activity, /item\.count \+= count;/);
});

test("usage updates do not self-merge existing invocations", async () => {
  const source = await readScript();
  const normalizeContext = vm.runInNewContext(
    `(${functionBody(source, "normalizeProfileContext", "hasProfileContext")})`,
    {
      normalizeReasoningEffort: (value: unknown) => String(value || ""),
      normalizeProfileInvocationRecord: (value: unknown) => value,
    },
  ) as (context?: Record<string, unknown>) => Record<string, unknown> & { invocations: unknown[] };
  const invocation = { type: "skill", skill_id: "superpowers", skill_name: "superpowers" };
  const turn: { context: Record<string, unknown> & { invocations: unknown[] } } = {
    context: { effort: "high", fastMode: false, invocations: [invocation] },
  };
  const context = {
    normalizeProfileContext: normalizeContext,
    normalizeReasoningEffort: (value: unknown) => String(value || ""),
  };
  const mergeContext = vm.runInNewContext(
    `(${functionBody(source, "mergeProfileContext", "performanceTimestampMs")})`,
    context,
  ) as (
    base?: Record<string, unknown>,
    next?: Record<string, unknown>,
  ) => Record<string, unknown> & { invocations: unknown[] };

  for (const usage of [
    { input: 100, output: 20, total: 120 },
    { input: 200, output: 40, total: 240 },
  ]) {
    const invocations: unknown[] = [];
    const turnContext = turn.context;
    const context = normalizeContext({
      effort: turnContext.effort,
      fastMode: turnContext.fastMode,
      invocations,
    });
    turn.context = mergeContext(turn.context, context);
    assert.ok(usage.total > 0);
  }

  assert.equal(turn.context.invocations.length, 1);
});

test("profile menu sync supports Radix portal menus without aria-controls", async () => {
  const source = await readScript();
  const sync = functionBody(source, "syncSidebarProfileMenuIdentity", "restoreSidebarProfileMenuIdentity");

  assert.match(sync, /button\?\.getAttribute\?\.\("aria-controls"\)/);
  assert.match(sync, /querySelectorAll\?\.\("\[role='menu'\]"\)/);
  assert.match(sync, /node\.getAttribute\?\.\("aria-labelledby"\) === button\.id/);
  assert.match(sync, /menu\.getAttribute\?\.\("aria-labelledby"\) !== button\.id/);
});

test("the optional CC Switch helper is bundled with a matching launcher", async () => {
  const [helper, launcher] = await Promise.all([readFile(helperPath, "utf8"), readFile(helperLauncherPath, "utf8")]);

  assert.match(helper, /const DEFAULT_PORT = 17888;/);
  assert.match(helper, /url\.pathname === "\/cc-switch\/turns"/);
  assert.match(helper, /url\.pathname === "\/health"/);
  assert.match(helper, /if \(require\.main === module\) startServer/);
  assert.match(launcher, /codex-local-usage-helper\.cjs/);
  assert.match(launcher, /PORT="\$\{PORT:-17888\}"/);
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
