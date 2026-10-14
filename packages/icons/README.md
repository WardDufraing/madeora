# @madeora/icons

Madeora's own SVG icons (`architecture.md` §16). No general-purpose icon pack is used.

## Rules

- Draw on a 24×24 grid with a 2px round stroke and no fill. Colour comes only from `currentColor`.
- One file per icon in `svg/`, named in lower-case words joined by hyphens (`arrow-left.svg` becomes `ArrowLeftIcon`).
- Only flat `path`, `circle`, `line`, `polyline` and `rect` elements with geometry attributes are accepted. The generator refuses anything else (scripts, event handlers, `href`, styles, groups, comments, entities).
- After adding or changing an SVG, run `pnpm --filter @madeora/icons generate` and commit `src/generated/icons.ts`. A test fails if it is out of date.
- Icons are decorative by default (`aria-hidden`). Pass `title` only when the icon alone carries meaning; icon-only buttons put their accessible name on the button instead.
- Sizes: `sm` 16px, `md` 20px (default), `lg` 24px.

## Inventory

All icons were drawn for Madeora on 13 October 2026 (S04 and S05; `chevron-down.svg` on 14 October 2026, S09) as original artwork: simple geometric shapes, not copied or adapted from any icon set. A test checks that this table lists exactly the exported icons.

| Component             | File                   | Used for                                                        |
| --------------------- | ---------------------- | --------------------------------------------------------------- |
| `CheckIcon`           | `check.svg`            | Checked checkbox                                                |
| `CloseIcon`           | `close.svg`            | Close and dismiss buttons (dialog, toast)                       |
| `InfoIcon`            | `info.svg`             | Information messages                                            |
| `SuccessIcon`         | `success.svg`          | Success messages                                                |
| `WarningIcon`         | `warning.svg`          | Warning messages                                                |
| `ErrorIcon`           | `error.svg`            | Error messages, field errors, the error state                   |
| `SpinnerIcon`         | `spinner.svg`          | Loading button and loading state (stops when motion is reduced) |
| `DashboardIcon`       | `dashboard.svg`        | Dashboard navigation item                                       |
| `CalendarIcon`        | `calendar.svg`         | Calendar navigation item                                        |
| `TasksIcon`           | `tasks.svg`            | Tasks navigation item                                           |
| `ChoresIcon`          | `chores.svg`           | Chores navigation item                                          |
| `MealsIcon`           | `meals.svg`            | Meals navigation item                                           |
| `ShoppingIcon`        | `shopping.svg`         | Shopping navigation item                                        |
| `HabitsIcon`          | `habits.svg`           | Habits navigation item                                          |
| `PetsIcon`            | `pets.svg`             | Pets navigation item                                            |
| `PhotosIcon`          | `photos.svg`           | Photos navigation item                                          |
| `IntegrationsIcon`    | `integrations.svg`     | Integrations navigation item                                    |
| `SettingsIcon`        | `settings.svg`         | Settings navigation item                                        |
| `HelpIcon`            | `help.svg`             | Help navigation item                                            |
| `MenuIcon`            | `menu.svg`             | Opens the navigation on small screens                           |
| `ChevronDownIcon`     | `chevron-down.svg`     | Opens the context switcher (turned over while it is open)       |
| `SidebarCollapseIcon` | `sidebar-collapse.svg` | Collapse the sidebar (mirrored in right-to-left layouts)        |
| `SidebarExpandIcon`   | `sidebar-expand.svg`   | Expand the sidebar (mirrored in right-to-left layouts)          |
