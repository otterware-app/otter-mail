/** Nightlies preview the next stable release, as in Otter Code. */
export function isNightlyVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(version);
}

export function releaseChannel(version: string): "stable" | "nightly" {
  return isNightlyVersion(version) ? "nightly" : "stable";
}

export function versionMatchesChannel(version: string, channel: "stable" | "nightly"): boolean {
  return channel === "nightly" ? isNightlyVersion(version) : /^\d+\.\d+\.\d+$/.test(version);
}
