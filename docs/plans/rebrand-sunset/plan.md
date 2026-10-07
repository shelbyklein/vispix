# Rebrand: Sunset palette, Sofia Pro + Karla

The new built-in default design (code defaults in `lib/api-zod/src/theme.ts` and `artifacts/photo-album/src/index.css`, not a saved theme). Builds on the live-theme system (#253).

## Spec (Shelby)

- Headings: Sofia Pro Semibold. Subtitle, paragraph, button: Karla Regular.
- Palette "Sunset, Light Accent", modified: Background `#FFFBF1`, Secondary Background `#E9C18D`, Headings `#5F696E`, Button Background `#CCD8E5`.

## Decisions

- Built-in default, so a theme saved before this change keeps its look (its button falls back to its primary).
- Dark mode derived: warm near-black, cream text; the button stays `#CCD8E5` with dark text.
- New tokens `button` / `button-foreground`: only the default Button variant uses them. `primary` stays the brand color (links, focus rings, icons, progress, badges, selected states) and is independent of button.
- New theme fields `headingWeight` (600), `buttonWeight` (400), `adobeFontsProject` (null); old saved themes parse with defaults.
- Sofia Pro is an Adobe Fonts font. Until a project ID exists, `--app-font-heading` is `"Sofia Pro", "Sofia Sans", sans-serif` and Google's Sofia Sans renders.
- Everything not in the spec is derived by us (see `DEFAULT_THEME`). Light `muted-foreground` is `200 8% 30%`: 36% lightness failed 4.5:1 on the tan sidebar.

## Token mapping

| Spec color | Value | Tokens |
|---|---|---|
| Background `#FFFBF1` | `42.9 100% 97.3%` | `background` |
| Secondary Background `#E9C18D` | `33.9 67.6% 73.3%` | `secondary`, `sidebar`, `chart-2` |
| Headings `#5F696E` | `200 7.3% 40.2%` | `heading-primary`, `heading-secondary`, `chart-3` |
| Button Background `#CCD8E5` | `211.2 32.5% 84.9%` | `button` (light and dark) |

Derived brand blue (links, focus): `primary` `211 32% 36%` (dark `211 50% 74%`).

## Contrast (WCAG ratio; text 4.5, headings 3)

| Pair | Light | Dark |
|---|---|---|
| foreground / background | 13.04 | 15.94 |
| foreground / card | 13.31 | 14.76 |
| muted-foreground / background | 8.16 | 8.10 |
| muted-foreground / muted | 7.29 | 6.62 |
| heading-primary / background (3) | 5.45 | 9.81 |
| heading-secondary / background (3) | 5.45 | 9.81 |
| heading-secondary / card (3) | 5.56 | 9.08 |
| button-foreground / button | 9.37 | 10.06 |
| primary / background | 6.84 | 9.24 |
| primary-foreground / primary | 7.06 | 8.36 |
| secondary-foreground / secondary | 8.64 | 5.23 |
| accent-foreground / accent | 11.34 | 11.65 |
| destructive-foreground / destructive | 5.89 | 5.08 |
| sidebar-foreground / sidebar | 9.23 | 16.04 |
| sidebar-foreground / sidebar-accent | 12.93 | 10.84 |
| sidebar-primary-foreground / sidebar-primary | 7.06 | 8.36 |
| muted-foreground / sidebar | 5.00 | 8.44 |
| warning-foreground / background | 4.88 | 10.82 |
| success-foreground / background | 5.40 | 9.52 |

All pass. The Design page's contrast panel also gained "Button text" and "Brand color on page".

## Pending: Adobe Fonts

1. In Adobe Fonts create a Web Project with Sofia Pro (weights 400-700) for the production domains; note the project ID (the `<id>` in `https://use.typekit.net/<id>.css`).
2. Uncomment the `<link rel="stylesheet" href="https://use.typekit.net/PROJECT_ID.css">` in `artifacts/photo-album/index.html` and put the ID in it. This loads the font for the built-in default (an unsaved theme serves an empty `theme.css`).
3. Set the same ID in `DEFAULT_THEME.adobeFontsProject` so Export CSS and saved themes carry it. Alternatively set "Adobe Fonts project ID" on the Design page and Save: `theme.css` then imports it.
4. nginx CSP already allows `use.typekit.net` and `p.typekit.net` (`deploy/nginx.conf`, noted in `deploy/DEPLOY.md`); deploy nginx with this change before enabling the font.

## Screenshots (1440x900, synthetic data)

`before-*` from `ffb48c8`, `after-*` from this change: `dashboard-light`, `dashboard-dark`, `photos-light`, `photo-detail-light`, `sign-in-light`, `design-page-light`, plus `after-buttons-light` and `after-buttons-light-hover` (default button hovered).
