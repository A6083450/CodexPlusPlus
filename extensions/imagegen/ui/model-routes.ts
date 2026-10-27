export function imageGenerationUsesProxy(profile: {
  imageGenerationProxy?: boolean; protocol: string; relayMode: string;
  officialMixApiKey: boolean; model?: string; modelList?: string;
}): boolean {
  return profile.imageGenerationProxy !== false && profile.protocol === "responses"
    && (profile.relayMode !== "official" || profile.officialMixApiKey)
    && `${profile.model ?? ""}\n${profile.modelList ?? ""}`.split("\n")
      .some(model => model.trim().toLowerCase().startsWith("gpt-image-"));
}
