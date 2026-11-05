# AnyWay Studio

A touch-first 3D game-creation studio for iPhone and iPad (also runs in a desktop browser).
It opens and saves the `.rbxl` / `.rbxlx` place-file formats, so you can move work between
this app and the desktop Roblox Studio. It is an independent project, not affiliated with or
endorsed by Roblox Corporation.

## Features

- **3D editor**: orbit, pan and pinch-zoom camera (WASD/QE fly on a keyboard); Select / Move / Scale / Rotate gizmos with grid snapping; undo/redo; duplicate, group/ungroup, copy/cut/paste; drag-to-reparent in the Explorer.
- **Explorer & Properties panels**: Position, Orientation, Size, Color, Material, Shape, Transparency, Anchored, CanCollide, and any other property in the file.
- **Parts**: Block, Sphere, Cylinder, Wedge, Corner Wedge, SpawnLocation, Seat, Models, Folders, lights, values and ClickDetectors.
- **Script editor**: syntax highlighting, live syntax checking, a coding key-row for touch keyboards, and snippets.
- **Play test**: a physics character (joystick + Jump on touch, WASD + Space on a keyboard) and a Lua runtime with a large part of the game API:
  `Instance.new`, `Touched`/`TouchEnded`, `task.wait/spawn/delay`, `Vector3`, `CFrame`, `Color3`, `BrickColor`, `Enum`,
  `TweenService`, `RunService.Heartbeat`, `Players.PlayerAdded`, `leaderstats` (shown as a leaderboard), `Humanoid` (Health, WalkSpeed, JumpPower),
  `ClickDetector.MouseClick`, `ModuleScript` + `require`, and Luau syntax such as `+=`, `continue`, `` `interpolation {x}` `` and type annotations.
- **Files**: open `.rbxl` (binary, LZ4/Zstd) and `.rbxlx` (XML). Save as either format; on iOS the share sheet opens and the file is also kept in Files › On My iPhone › AnyWay Studio. The current place is autosaved so it can be restored later.
- **Learn panel**: step-by-step lessons with "Build it for me" buttons (beginner basics, obby, kill brick, coins & leaderboard, click door, moving platform), plus links to video tutorials and documentation.

## Getting the iPhone app (.ipa)

Every push runs `.github/workflows/ios.yml` on a macOS runner and uploads **AnyWayStudio-unsigned.ipa**
as a build artifact (Actions tab → latest run → Artifacts).

The IPA is unsigned. Install it with a sideloading tool that signs it with your own Apple ID,
such as Sideloadly or AltStore. For TestFlight or App Store distribution, open `ios/App/App.xcworkspace`
in Xcode, choose your team under Signing & Capabilities, then Product → Archive.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # file-format round-trip tests (pass .rbxl paths to test real files)
npm run build        # production web build → dist/
npx cap sync ios     # copy the web build into the Xcode project (needs macOS + CocoaPods to build)
npm run icons        # re-render app icons from public/logo.svg
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/core` | Instance tree / data model and value types |
| `src/io` | `.rbxl` binary and `.rbxlx` XML readers and writers, LZ4, file open/save |
| `src/editor` | App shell, 3D scene, gizmos, history |
| `src/ui` | Explorer, Properties, Script editor, Learn panel, styles |
| `src/play` | Play-test physics (cannon-es), character, Lua runtime (fengari) |
| `ios/` | Capacitor iOS project |

## Known limitations

- Scripts run on a Lua 5.3 VM with a Luau compatibility layer. Most beginner and intermediate scripts work, but advanced Luau features and many services are not implemented.
- There is no Terrain, no GUI rendering (ScreenGui and similar objects are kept in the file but not drawn), no meshes or unions (they show as boxes), and no publishing to the Roblox website.
- Some newer property types are skipped when reading a file. A warning appears in Output when that happens.
