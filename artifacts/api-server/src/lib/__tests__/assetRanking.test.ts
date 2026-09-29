import { describe, it, expect } from "vitest";
import { parseAssetQuery, rankBrandAssets, type RankableAsset } from "../imageGeneration/assetRanking";

// Fixture from the functional review (#206): the primary mark exists, but
// alphabetically earlier brand assets (badges, a shirt, an event logo) used to
// win because retrieval sorted all brand assets by name.
const asset = (id: number, name: string, extra: Partial<RankableAsset> = {}): RankableAsset => ({
  id, name, kind: "brand", variant: null, notes: null, projectId: null, projectName: null, isPrimary: false, ...extra,
});

const LIB: RankableAsset[] = [
  asset(1, "Achievement Badge — Gold", { variant: "award" }),
  asset(2, "Achievement Badge — Silver", { variant: "award" }),
  asset(3, "Apparel — Team Shirt", { notes: "USA Archery team shirt mockup" }),
  asset(4, "Event Logo — Gator Cup", { variant: "event", notes: "2026 Gator Cup event mark" }),
  asset(5, "USA Archery Logo", { variant: "primary", isPrimary: true, notes: "Main mark. Full color on light backgrounds." }),
  asset(6, "USA Archery Logo", { variant: "white", notes: "Reverse for dark backgrounds." }),
  asset(7, "USA Archery Logo", { variant: "horizontal", notes: "Wide lockup for banners." }),
  asset(8, "USA Archery Icon", { variant: "icon" }),
  asset(9, "Style reference — 2025 poster", { kind: "reference" }),
  asset(10, "Nationals Logo", { projectId: 42, projectName: "Nationals 2026", isPrimary: true, variant: "primary" }),
];

const top = (query: string, opts?: { projectId?: number }) => rankBrandAssets(LIB, query, opts);

describe("asset query parsing", () => {
  it("separates variants, primary intent and identity words", () => {
    expect(parseAssetQuery("USA Archery primary logo")).toEqual({ variants: [], wantsPrimary: true, identity: ["usa", "archery"] });
    expect(parseAssetQuery("white horizontal logo").variants.sort()).toEqual(["horizontal", "white"]);
  });
});

describe("brand asset ranking (TT-VPX-BRAND-01/02)", () => {
  it("puts the designated primary first for the reviewed request, ahead of alphabetically earlier assets", () => {
    const r = top("USA Archery primary logo");
    expect(r[0].asset.id).toBe(5);
    expect(r[0].confidence).toBe("high");
    expect(r[0].reasons).toContain("Designated primary logo");
    // Badges, the shirt and the event logo are all below the three USA Archery marks.
    const pos = (id: number) => r.findIndex((x) => x.asset.id === id);
    for (const unrelated of [1, 2, 3, 4]) expect(pos(unrelated)).toBeGreaterThan(pos(7));
  });

  it("uses the designated primary for a generic logo request", () => {
    expect(top("logo")[0].asset.id).toBe(5);
  });

  it.each([
    ["USA Archery white logo", 6, "white"],
    ["horizontal logo for a banner", 7, "horizontal"],
    ["icon only mark", 8, "icon"],
  ])("ranks the requested variant first: %s", (query, id, variant) => {
    const r = top(query);
    expect(r[0].asset.id).toBe(id);
    expect(r[0].reasons.join(" ")).toContain(`requested ${variant} variant`);
  });

  it("finds a specific event logo by identity words", () => {
    const r = top("Gator Cup event logo");
    expect(r[0].asset.id).toBe(4);
    expect(r[0].reasons.join(" ")).toContain("gator cup");
  });

  it("prefers the project's designated primary inside a project, the org's otherwise", () => {
    expect(top("logo", { projectId: 42 })[0].asset.id).toBe(10);
    expect(top("logo")[0].asset.id).toBe(5);
    // Other projects' assets are out of scope for a project request.
    expect(top("logo", { projectId: 99 }).some((x) => x.asset.id === 10)).toBe(false);
  });

  it("without a designated primary, a bare 'logo' request is low confidence rather than a silent pick", () => {
    const noPrimary = LIB.map((a) => ({ ...a, isPrimary: false }));
    const r = rankBrandAssets(noPrimary, "logo");
    expect(r[0].confidence).not.toBe("high");
  });

  it("orders ties deterministically", () => {
    const a = rankBrandAssets([asset(2, "B"), asset(1, "A"), asset(3, "A")], "logo").map((x) => x.asset.id);
    expect(a).toEqual([1, 3, 2]);
  });
});
