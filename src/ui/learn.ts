import type { App } from '../editor/app';
import { createInstance, isPart, KILL_SCRIPT } from '../core/instance';
import { cf, v3, c3u8, en, str, bool } from '../core/types';
import { openExternal } from '../io/files';
import { ICON } from './icons';

type Lesson = { title: string; level: string; steps: string[]; build?: (app: App) => void };

const COIN_SCRIPT = `local coin = script.Parent
local debounce = false

coin.Touched:Connect(function(hit)
\tlocal player = game.Players:GetPlayerFromCharacter(hit.Parent)
\tif player and not debounce then
\t\tdebounce = true
\t\tlocal coins = player.leaderstats.Coins
\t\tcoins.Value = coins.Value + 1
\t\tcoin.Transparency = 1
\t\ttask.wait(3)
\t\tcoin.Transparency = 0
\t\tdebounce = false
\tend
end)

-- spin
while true do
\tcoin.CFrame = coin.CFrame * CFrame.Angles(0, math.rad(4), 0)
\ttask.wait()
end
`;
const LEADERSTATS = `game.Players.PlayerAdded:Connect(function(player)
\tlocal leaderstats = Instance.new("Folder")
\tleaderstats.Name = "leaderstats"
\tleaderstats.Parent = player

\tlocal coins = Instance.new("IntValue")
\tcoins.Name = "Coins"
\tcoins.Parent = leaderstats
end)
`;
const DOOR = `local door = script.Parent
local detector = Instance.new("ClickDetector")
detector.Parent = door
local open = false

detector.MouseClick:Connect(function()
\topen = not open
\tdoor.Transparency = open and 0.7 or 0
\tdoor.CanCollide = not open
end)
`;
const PLATFORM = `local TweenService = game:GetService("TweenService")
local platform = script.Parent
local info = TweenInfo.new(3, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true)
TweenService:Create(platform, info, { Position = platform.Position + Vector3.new(0, 0, -24) }):Play()
`;

const LESSONS: Lesson[] = [
  {
    title: '0 · Absolute beginner basics', level: 'Beginner',
    steps: [
      'File → New Baseplate gives you a grey floor and a SpawnLocation (where players appear).',
      'Camera: drag with one finger to look around, pinch to zoom, two fingers to pan. Keyboard: W A S D to fly, Q / E down / up, F to focus the selected part.',
      'Explorer (right side, or the panel button on phones) lists everything in your game: Workspace holds the 3D world, ServerScriptService holds scripts.',
      'Insert a part: tap Part → Block. Tap it in the world or in the Explorer to select it.',
      'Move / Scale / Rotate: pick a tool in the top bar and drag the coloured handles. The magnet snaps to whole studs.',
      'Properties: change Name, Color, Material, Transparency and Size of the selected part.',
      'Anchored: turn it on so the part stays in the air and does not fall when the game runs.',
      'Edit → Duplicate copies a part; Edit → Group bundles parts into a Model; Delete removes them.',
      'Press Play to test as a character (joystick + Jump on touch screens, WASD + Space on a keyboard). Press Stop to return; changes made while playing are thrown away.',
      'Undo / Redo fix mistakes. File → Download as .rbxl saves your place so you can open it on a computer.',
    ],
    build: app => {
      const p = createInstance('Part');
      p.name = 'MyFirstPart';
      p.props.set('Anchored', bool(true));
      p.props.set('size', v3(6, 2, 6));
      p.props.set('CFrame', cf(0, 6, -14));
      p.props.set('Color3uint8', c3u8(0, 162, 255));
      p.props.set('Material', en(272));
      p.setParent(app.model.workspace);
    },
  },
  {
    title: '1 · Move around the editor', level: 'Beginner',
    steps: ['One finger drag = orbit the camera. Two fingers = pan & pinch to zoom.', 'On a keyboard: W A S D + Q / E fly the camera.', 'Tap a part to select it. Tap empty space to deselect.', 'Use the Move / Scale / Rotate tools in the top bar, then drag the coloured handles.', 'Toggle the magnet to snap to 1-stud steps and 15° turns.'],
  },
  {
    title: '2 · Build your first obby stage', level: 'Beginner',
    steps: ['Tap Part → Block.', 'Turn on Anchored in Properties so it will not fall.', 'Change its Color and Material.', 'Duplicate it (Edit → Duplicate) and move the copy further away.', 'Press Play and jump across!'],
    build: app => {
      const colors: [number, number, number][] = [[255, 89, 89], [255, 176, 0], [0, 200, 120], [0, 150, 255]];
      colors.forEach((c, k) => {
        const p = createInstance('Part');
        p.name = 'Stage' + (k + 1);
        p.props.set('Anchored', bool(true));
        p.props.set('size', v3(6, 1, 6));
        p.props.set('CFrame', cf(0, 1 + k * 2, -12 - k * 9));
        p.props.set('Color3uint8', c3u8(...c));
        p.setParent(app.model.workspace);
      });
    },
  },
  {
    title: '3 · Make a kill brick', level: 'Beginner',
    steps: ['Insert a Part, make it red Neon and Anchored.', 'With the part selected, tap Script to add a Script inside it.', 'Paste the kill-brick code (or use Snippet → Kill brick).', 'Play and touch it — your character resets.'],
    build: app => {
      const p = createInstance('Part');
      p.name = 'KillBrick';
      p.props.set('Anchored', bool(true));
      p.props.set('size', v3(8, 1, 8));
      p.props.set('CFrame', cf(14, 0.5, 0));
      p.props.set('Color3uint8', c3u8(255, 40, 40));
      p.props.set('Material', en(288));
      p.setParent(app.model.workspace);
      const s = createInstance('Script');
      s.props.set('Source', str(KILL_SCRIPT));
      s.setParent(p);
    },
  },
  {
    title: '4 · Coins & a leaderboard', level: 'Intermediate',
    steps: ['Add a Script in ServerScriptService that creates leaderstats for each player.', 'Add a yellow cylinder “Coin” with a Script that adds +1 when touched.', 'Play: the leaderboard appears in the top-right corner.'],
    build: app => {
      const sss = app.model.service('ServerScriptService');
      const ls = createInstance('Script'); ls.name = 'Leaderstats'; ls.props.set('Source', str(LEADERSTATS)); ls.setParent(sss);
      for (let k = 0; k < 5; k++) {
        const c = createInstance('Part');
        c.name = 'Coin';
        c.props.set('shape', en(2));
        c.props.set('Anchored', bool(true));
        c.props.set('CanCollide', bool(false));
        c.props.set('size', v3(0.4, 3, 3));
        c.props.set('CFrame', cf(-10 + k * 5, 2.5, 10));
        c.props.set('Color3uint8', c3u8(255, 200, 0));
        c.props.set('Material', en(288));
        c.setParent(app.model.workspace);
        const s = createInstance('Script'); s.props.set('Source', str(COIN_SCRIPT)); s.setParent(c);
      }
    },
  },
  {
    title: '5 · A door you can click', level: 'Intermediate',
    steps: ['Insert a tall Part (Size 6, 10, 1) and anchor it.', 'Add a Script that creates a ClickDetector and toggles the door.', 'Play and tap the door to open / close it.'],
    build: app => {
      const d = createInstance('Part');
      d.name = 'Door';
      d.props.set('Anchored', bool(true));
      d.props.set('size', v3(6, 10, 1));
      d.props.set('CFrame', cf(-16, 5, 0));
      d.props.set('Color3uint8', c3u8(124, 92, 70));
      d.props.set('Material', en(528));
      d.setParent(app.model.workspace);
      const s = createInstance('Script'); s.props.set('Source', str(DOOR)); s.setParent(d);
    },
  },
  {
    title: '6 · Moving platform with TweenService', level: 'Advanced',
    steps: ['Create an anchored platform.', 'Add a Script using TweenService:Create with a repeating, reversing TweenInfo.', 'Play and ride the platform.'],
    build: app => {
      const p = createInstance('Part');
      p.name = 'MovingPlatform';
      p.props.set('Anchored', bool(true));
      p.props.set('size', v3(8, 1, 8));
      p.props.set('CFrame', cf(0, 3, 20));
      p.props.set('Color3uint8', c3u8(0, 170, 255));
      p.setParent(app.model.workspace);
      const s = createInstance('Script'); s.props.set('Source', str(PLATFORM)); s.setParent(p);
    },
  },
  {
    title: '7 · Export to the official desktop editor', level: 'Any',
    steps: ['File → Download as .rbxl saves a binary place file.', 'On iPhone/iPad the share sheet opens — save it to Files, AirDrop it, or send it to your computer.', 'Open the .rbxl in the desktop Studio app to keep working or publish it.', 'You can also File → Open an existing .rbxl / .rbxlx to edit it here.'],
  },
];

const VIDEOS: { title: string; q?: string; url?: string }[] = [
  { title: 'ABSOLUTE Beginner Basics — Studio for Noobs 2025 (RoBuilder)', url: 'https://youtu.be/-5OOovmkJss' },
  { title: 'Studio for complete beginners', q: 'roblox studio beginner tutorial' },
  { title: 'How to make an obby', q: 'roblox studio how to make an obby' },
  { title: 'Scripting basics (Luau)', q: 'roblox studio scripting tutorial for beginners' },
  { title: 'Kill bricks & Touched events', q: 'roblox studio kill brick script tutorial' },
  { title: 'Leaderstats & coins', q: 'roblox studio leaderstats coins tutorial' },
  { title: 'TweenService explained', q: 'roblox studio tweenservice tutorial' },
  { title: 'Building tips: Move / Scale / Rotate', q: 'roblox studio building tips move scale rotate' },
];

export class Learn {
  constructor(private app: App, private el: HTMLElement) {
    el.innerHTML = `
      <div class="learn-head"><b>Learn</b><span class="grow"></span><button data-l="close">${ICON.close}</button></div>
      <div class="learn-body">
        <h4>Interactive lessons</h4>
        ${LESSONS.map((l, k) => `
          <details class="lesson"><summary><span>${l.title}</span><em>${l.level}</em></summary>
            <ol>${l.steps.map(s => `<li>${s}</li>`).join('')}</ol>
            ${l.build ? `<button class="primary" data-build="${k}">Build it for me</button>` : ''}
          </details>`).join('')}
        <h4>Video tutorials</h4>
        <p class="muted">Opens the video (or YouTube results for the topic) in your browser.</p>
        <div class="videos">${VIDEOS.map((v, k) => `<button class="video" data-video="${k}">${ICON.video}<span>${v.title}</span></button>`).join('')}</div>
        <h4>Documentation</h4>
        <div class="videos">
          <button class="video" data-url="https://create.roblox.com/docs">${ICON.learn}<span>Creator documentation</span></button>
          <button class="video" data-url="https://create.roblox.com/docs/tutorials">${ICON.learn}<span>Official tutorials</span></button>
          <button class="video" data-url="https://luau.org">${ICON.script}<span>Luau language</span></button>
        </div>
      </div>`;
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b) return;
      if (b.dataset.l === 'close') this.toggle(false);
      else if (b.dataset.build) {
        if (this.app.play) this.app.stopPlay();
        LESSONS[Number(b.dataset.build)].build!(this.app);
        this.app.commit();
        this.app.frameAll();
        this.app.toast('Lesson objects added — press Play to try it!');
        const last = this.app.model.workspace.children.filter(isPart).pop();
        if (last) this.app.select([last]);
      } else if (b.dataset.video) { const v = VIDEOS[Number(b.dataset.video)]; openExternal(v.url ?? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(v.q ?? '')); }
      else if (b.dataset.url) openExternal(b.dataset.url);
    });
  }
  toggle(force?: boolean) { this.el.classList.toggle('open', force); }
}
