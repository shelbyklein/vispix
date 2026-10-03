import { describe, expect, it } from "vitest";
import { formatDimensions, formatFileSize, photoAltText, photoControlLabel, photoName } from "./photo-a11y";

describe("photoName", () => {
  it("prefers the filename, then name, then the ID", () => {
    expect(photoName({ id: 7, filename: " a.jpg " })).toBe("a.jpg");
    expect(photoName({ id: 7, name: "b.jpg" })).toBe("b.jpg");
    expect(photoName({ id: 7, filename: null })).toBe("Photo 7");
    expect(photoName({ id: 7, filename: "  " })).toBe("Photo 7");
  });
});

describe("photoControlLabel", () => {
  it("adds album and extra context", () => {
    expect(
      photoControlLabel("Open", { id: 1, filename: "a.jpg" }, { albumTitle: "Regionals", extra: "exact match" }),
    ).toBe("Open a.jpg, album Regionals, exact match");
  });
  it("falls back to the ID and skips blank context", () => {
    expect(photoControlLabel("Preview", { id: 9 }, { albumTitle: " ", extra: null })).toBe("Preview Photo 9");
  });
  it("distinguishes adjacent photos", () => {
    const a = photoControlLabel("Open", { id: 1, filename: "a.jpg" });
    const b = photoControlLabel("Open", { id: 2, filename: "b.jpg" });
    expect(a).not.toBe(b);
  });
});

describe("photoAltText", () => {
  it("is empty (decorative) without a description", () => {
    expect(photoAltText(null)).toBe("");
    expect(photoAltText("   ")).toBe("");
  });
  it("normalises whitespace and truncates long text", () => {
    expect(photoAltText("An archer\n  at full draw")).toBe("An archer at full draw");
    const long = photoAltText("x".repeat(400));
    expect(long.length).toBe(250);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("formatDimensions", () => {
  it("formats known dimensions and hides unknown ones", () => {
    expect(formatDimensions(1920, 1080)).toBe("1,920 × 1,080 px");
    expect(formatDimensions(null, 1080)).toBeNull();
    expect(formatDimensions(0, 0)).toBeNull();
  });
});

describe("formatFileSize", () => {
  it("scales units", () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatFileSize(15 * 1024)).toBe("15 KB");
  });
});
