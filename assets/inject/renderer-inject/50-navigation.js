  function installCodexPlusNavigationEntries() {
    if (installCodexPlusRailNavigation()) {
      detachCodexPlusSidebarNavigation();
      return;
    }
    removeCodexPlusRailNavigation();
    installCodexPlusSidebarNavigation();
  }

  const codexPluginRemoteOnlyMarketplaceKinds = new Set(["created-by-me-remote", "shared-with-me"]);

  function pluginMarketplaceRequestProfile(params) {
    const marketplaceKinds = Array.isArray(params?.marketplaceKinds)
      ? Array.from(new Set(params.marketplaceKinds.map((kind) => restorePluginMarketplaceName(kind))))
      : [];
    const hasRemoteOnlyKind = marketplaceKinds.some((kind) => codexPluginRemoteOnlyMarketplaceKinds.has(kind));
    const hasLocalKind = marketplaceKinds.includes("local");
    const hasOtherKind = marketplaceKinds.some(
      (kind) => !codexPluginRemoteOnlyMarketplaceKinds.has(kind) && kind !== "vertical"
    );
    return {
      marketplaceKinds,
      remoteOnly: hasRemoteOnlyKind && !hasLocalKind && !hasOtherKind,
    };
  }
