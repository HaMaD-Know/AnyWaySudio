// Lua-side half of the scripting API. Runs once per play session.
export const PRELUDE = String.raw`
local __get, __set, __call, __now, __print, __new = __get, __set, __call, __now, __print, __new
_G.__get, _G.__set, _G.__call, _G.__print, _G.__new = nil, nil, nil, nil, nil
local unpack = table.unpack
local floor, sqrt, sin, cos, abs = math.floor, math.sqrt, math.sin, math.cos, math.abs

-- ---------- Luau-style helpers ----------
local rawtostring = tostring
function tostring(v)
  if math.type(v) == 'float' and v == floor(v) and abs(v) < 1e15 then return string.format('%d', v) end
  return rawtostring(v)
end
local function fmtargs(...)
  local t = table.pack(...)
  for i = 1, t.n do t[i] = tostring(t[i]) end
  return table.concat(t, ' ', 1, t.n)
end
function print(...) __print(fmtargs(...), 'info') end
function warn(...) __print(fmtargs(...), 'warn') end
function math.clamp(x, a, b) if x < a then return a elseif x > b then return b end return x end
function math.round(x) return floor(x + 0.5) end
function math.sign(x) if x > 0 then return 1 elseif x < 0 then return -1 end return 0 end
function math.noise(x, y, z) return (sin((x or 0) * 12.9898 + (y or 0) * 78.233 + (z or 0) * 37.719) * 0.5) end
math.huge = math.huge or 1/0
function table.find(t, v, init) for i = init or 1, #t do if t[i] == v then return i end end return nil end
function table.clear(t) for k in pairs(t) do t[k] = nil end end
function table.create(n, v) local t = {} for i = 1, n do t[i] = v end return t end
function table.freeze(t) return t end
function table.clone(t) local c = {} for k, v in pairs(t) do c[k] = v end return c end
function string.split(s, sep)
  sep = sep or ','
  local out, i = {}, 1
  while true do
    local a, b = string.find(s, sep, i, true)
    if not a then out[#out + 1] = string.sub(s, i) break end
    out[#out + 1] = string.sub(s, i, a - 1)
    i = b + 1
  end
  return out
end
function typeof(v)
  local mt = getmetatable(v)
  if type(mt) == 'table' and mt.__type then return mt.__type end
  return type(v)
end
function tick() return __now() end
function time() return __now() - __START end
function os.time() return floor(__now()) end
function os.clock() return __now() end
__START = __now()

-- ---------- scheduler ----------
local sleeping = {}
local deferred = {}
local budgetStart = 0
local function hook()
  if __now() - budgetStart > 5 then
    error('Script timeout: exhausted allowed execution time (add a wait() inside loops)', 2)
  end
end
local function resume(co, ...)
  budgetStart = __now()
  local ok, err = coroutine.resume(co, ...)
  if not ok then __print(tostring(err), 'error') end
end
local function newthread(f)
  local co = coroutine.create(f)
  debug.sethook(co, hook, '', 20000)
  return co
end
task = {}
function task.spawn(f, ...)
  if type(f) == 'thread' then resume(f, ...) return f end
  local co = newthread(f)
  resume(co, ...)
  return co
end
function task.defer(f, ...)
  local co = type(f) == 'thread' and f or newthread(f)
  deferred[#deferred + 1] = { co = co, args = table.pack(...) }
  return co
end
function task.delay(t, f, ...)
  local co = type(f) == 'thread' and f or newthread(f)
  sleeping[#sleeping + 1] = { co = co, at = __now() + (t or 0), args = table.pack(...) }
  return co
end
function task.wait(t)
  t = t or 0
  local co, main = coroutine.running()
  if main then error('wait() can only be used inside a script thread', 2) end
  local start = __now()
  sleeping[#sleeping + 1] = { co = co, at = start + t, start = start }
  return coroutine.yield()
end
function task.cancel(co)
  for i = #sleeping, 1, -1 do if sleeping[i].co == co then table.remove(sleeping, i) end end
end
wait = function(t) local d = task.wait(t or 0.03) return d, __now() end
spawn = function(f) task.defer(f) end
delay = task.delay

function __step()
  local now = __now()
  local due = {}
  for i = #sleeping, 1, -1 do
    local s = sleeping[i]
    if s.at <= now then table.remove(sleeping, i) due[#due + 1] = s end
  end
  for i = #due, 1, -1 do
    local s = due[i]
    if coroutine.status(s.co) == 'suspended' then
      if s.args then resume(s.co, unpack(s.args, 1, s.args.n)) else resume(s.co, now - (s.start or now)) end
    end
  end
  local d = deferred
  deferred = {}
  for _, s in ipairs(d) do if coroutine.status(s.co) == 'suspended' then resume(s.co, unpack(s.args, 1, s.args.n)) end end
end

-- ---------- datatypes ----------
local V3 = { __type = 'Vector3' }
V3.__index = function(v, k)
  if k == 'Magnitude' then return sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z) end
  if k == 'Unit' then local m = sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z) if m == 0 then return v end return Vector3.new(v.X / m, v.Y / m, v.Z / m) end
  if k == 'x' then return v.X elseif k == 'y' then return v.Y elseif k == 'z' then return v.Z end
  return V3[k]
end
Vector3 = {}
function Vector3.new(x, y, z) return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, V3) end
local v3 = Vector3.new
Vector3.zero = v3(0, 0, 0); Vector3.one = v3(1, 1, 1)
Vector3.xAxis = v3(1, 0, 0); Vector3.yAxis = v3(0, 1, 0); Vector3.zAxis = v3(0, 0, 1)
V3.__add = function(a, b) return v3(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
V3.__sub = function(a, b) return v3(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
V3.__mul = function(a, b)
  if type(a) == 'number' then return v3(b.X * a, b.Y * a, b.Z * a) end
  if type(b) == 'number' then return v3(a.X * b, a.Y * b, a.Z * b) end
  return v3(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
V3.__div = function(a, b) if type(b) == 'number' then return v3(a.X / b, a.Y / b, a.Z / b) end return v3(a.X / b.X, a.Y / b.Y, a.Z / b.Z) end
V3.__unm = function(a) return v3(-a.X, -a.Y, -a.Z) end
V3.__eq = function(a, b) return a.X == b.X and a.Y == b.Y and a.Z == b.Z end
V3.__tostring = function(a) return tostring(a.X) .. ', ' .. tostring(a.Y) .. ', ' .. tostring(a.Z) end
function V3.Dot(a, b) return a.X * b.X + a.Y * b.Y + a.Z * b.Z end
function V3.Cross(a, b) return v3(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X) end
function V3.Lerp(a, b, t) return a + (b - a) * t end
function V3.Abs(a) return v3(abs(a.X), abs(a.Y), abs(a.Z)) end
function V3.FuzzyEq(a, b, e) return (a - b).Magnitude <= (e or 1e-5) end

local V2 = { __type = 'Vector2' }
V2.__index = function(v, k) if k == 'Magnitude' then return sqrt(v.X * v.X + v.Y * v.Y) end return V2[k] end
Vector2 = { new = function(x, y) return setmetatable({ X = x or 0, Y = y or 0 }, V2) end }
V2.__add = function(a, b) return Vector2.new(a.X + b.X, a.Y + b.Y) end
V2.__sub = function(a, b) return Vector2.new(a.X - b.X, a.Y - b.Y) end
V2.__mul = function(a, b) if type(b) == 'number' then return Vector2.new(a.X * b, a.Y * b) end return Vector2.new(a.X * b.X, a.Y * b.Y) end
V2.__tostring = function(a) return tostring(a.X) .. ', ' .. tostring(a.Y) end

local C3 = { __type = 'Color3' }
C3.__index = C3
Color3 = {}
function Color3.new(r, g, b) return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, C3) end
function Color3.fromRGB(r, g, b) return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255) end
function Color3.fromHex(h) h = h:gsub('#', '') return Color3.fromRGB(tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16)) end
function Color3.fromHSV(h, s, v)
  local i = floor(h * 6) local f = h * 6 - i
  local p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
  i = i % 6
  if i == 0 then return Color3.new(v, t, p) elseif i == 1 then return Color3.new(q, v, p) elseif i == 2 then return Color3.new(p, v, t)
  elseif i == 3 then return Color3.new(p, q, v) elseif i == 4 then return Color3.new(t, p, v) end
  return Color3.new(v, p, q)
end
function C3.Lerp(a, b, t) return Color3.new(a.R + (b.R - a.R) * t, a.G + (b.G - a.G) * t, a.B + (b.B - a.B) * t) end
function C3.ToHex(a) return string.format('%02X%02X%02X', floor(a.R * 255 + .5), floor(a.G * 255 + .5), floor(a.B * 255 + .5)) end
C3.__eq = function(a, b) return a.R == b.R and a.G == b.G and a.B == b.B end
C3.__tostring = function(a) return tostring(a.R) .. ', ' .. tostring(a.G) .. ', ' .. tostring(a.B) end

local BRICKS = {
  ['White'] = {242,243,243}, ['Institutional white'] = {248,248,248}, ['Really black'] = {17,17,17}, ['Black'] = {27,42,53},
  ['Bright red'] = {196,40,28}, ['Really red'] = {255,0,0}, ['Bright blue'] = {13,105,172}, ['Really blue'] = {0,0,255},
  ['Bright yellow'] = {245,205,48}, ['New Yeller'] = {255,255,0}, ['Bright green'] = {75,151,75}, ['Lime green'] = {0,255,0},
  ['Dark green'] = {40,127,71}, ['Bright orange'] = {218,133,65}, ['Medium stone grey'] = {163,162,165}, ['Dark stone grey'] = {99,95,98},
  ['Hot pink'] = {255,0,191}, ['Royal purple'] = {98,37,209}, ['Cyan'] = {4,175,236}, ['Brown'] = {124,92,70}, ['Reddish brown'] = {105,64,40},
  ['Gold'] = {239,184,56}, ['Teal'] = {18,238,212}, ['Pastel blue'] = {128,187,219}, ['Toothpaste'] = {0,255,255}, ['Deep orange'] = {255,176,0},
}
local BC = { __type = 'BrickColor' }
BC.__index = BC
BC.__tostring = function(b) return b.Name end
BC.__eq = function(a, b) return a.Name == b.Name end
BrickColor = {}
function BrickColor.new(name, g, b)
  if type(name) == 'number' and g then local c = Color3.fromRGB(name, g, b) return setmetatable({ Name = 'Custom', Color = c }, BC) end
  if typeof(name) == 'Color3' then return setmetatable({ Name = 'Custom', Color = name }, BC) end
  local c = BRICKS[name] or BRICKS['Medium stone grey']
  return setmetatable({ Name = BRICKS[name] and name or 'Medium stone grey', Color = Color3.fromRGB(c[1], c[2], c[3]) }, BC)
end
function BrickColor.Random() local names = {} for k in pairs(BRICKS) do names[#names + 1] = k end table.sort(names) return BrickColor.new(names[math.random(#names)]) end
function BrickColor.White() return BrickColor.new('White') end
function BrickColor.Black() return BrickColor.new('Black') end
function BrickColor.Red() return BrickColor.new('Bright red') end
function BrickColor.Green() return BrickColor.new('Bright green') end
function BrickColor.Blue() return BrickColor.new('Bright blue') end
function BrickColor.Yellow() return BrickColor.new('Bright yellow') end

-- CFrame: X,Y,Z + row-major 3x3 rotation in R
local CF = { __type = 'CFrame' }
local function mkcf(x, y, z, r) return setmetatable({ X = x, Y = y, Z = z, R = r }, CF) end
local function rmul(a, b)
  local o = {}
  for i = 0, 2 do for j = 0, 2 do
    o[i * 3 + j + 1] = a[i * 3 + 1] * b[j + 1] + a[i * 3 + 2] * b[3 + j + 1] + a[i * 3 + 3] * b[6 + j + 1]
  end end
  return o
end
local function rvec(r, x, y, z) return r[1] * x + r[2] * y + r[3] * z, r[4] * x + r[5] * y + r[6] * z, r[7] * x + r[8] * y + r[9] * z end
local function rT(r) return { r[1], r[4], r[7], r[2], r[5], r[8], r[3], r[6], r[9] } end
local ID = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }
local function rx(a) local c, s = cos(a), sin(a) return { 1, 0, 0, 0, c, -s, 0, s, c } end
local function ry(a) local c, s = cos(a), sin(a) return { c, 0, s, 0, 1, 0, -s, 0, c } end
local function rz(a) local c, s = cos(a), sin(a) return { c, -s, 0, s, c, 0, 0, 0, 1 } end
CFrame = {}
function CFrame.new(a, b, c, ...)
  if a == nil then return mkcf(0, 0, 0, ID) end
  if type(a) == 'number' then
    local rest = { ... }
    if #rest == 9 then return mkcf(a, b, c, rest) end
    return mkcf(a, b or 0, c or 0, ID)
  end
  if b ~= nil and typeof(b) == 'Vector3' then return CFrame.lookAt(a, b) end
  return mkcf(a.X, a.Y, a.Z, ID)
end
function CFrame.lookAt(pos, at, up)
  up = up or v3(0, 1, 0)
  local f = (at - pos).Unit
  local r = f:Cross(up).Unit
  if r.Magnitude < 1e-6 then r = v3(1, 0, 0) end
  local u = r:Cross(f)
  -- columns: right, up, back(-forward)
  return mkcf(pos.X, pos.Y, pos.Z, { r.X, u.X, -f.X, r.Y, u.Y, -f.Y, r.Z, u.Z, -f.Z })
end
function CFrame.Angles(a, b, c) return mkcf(0, 0, 0, rmul(rmul(rx(a or 0), ry(b or 0)), rz(c or 0))) end
CFrame.fromEulerAnglesXYZ = CFrame.Angles
function CFrame.fromOrientation(a, b, c) return mkcf(0, 0, 0, rmul(rmul(ry(b or 0), rx(a or 0)), rz(c or 0))) end
CFrame.fromEulerAnglesYXZ = CFrame.fromOrientation
function CFrame.fromAxisAngle(axis, ang)
  local u = axis.Unit local x, y, z = u.X, u.Y, u.Z local c, s = cos(ang), sin(ang) local t = 1 - c
  return mkcf(0, 0, 0, { t*x*x + c, t*x*y - s*z, t*x*z + s*y, t*x*y + s*z, t*y*y + c, t*y*z - s*x, t*x*z - s*y, t*y*z + s*x, t*z*z + c })
end
CFrame.identity = mkcf(0, 0, 0, ID)
CF.__index = function(c, k)
  if k == 'Position' or k == 'p' then return v3(c.X, c.Y, c.Z) end
  if k == 'LookVector' or k == 'lookVector' then return v3(-c.R[3], -c.R[6], -c.R[9]) end
  if k == 'RightVector' then return v3(c.R[1], c.R[4], c.R[7]) end
  if k == 'UpVector' then return v3(c.R[2], c.R[5], c.R[8]) end
  if k == 'Rotation' then return mkcf(0, 0, 0, c.R) end
  if k == 'x' then return c.X elseif k == 'y' then return c.Y elseif k == 'z' then return c.Z end
  return CF[k]
end
CF.__mul = function(a, b)
  if typeof(b) == 'Vector3' then local x, y, z = rvec(a.R, b.X, b.Y, b.Z) return v3(a.X + x, a.Y + y, a.Z + z) end
  local x, y, z = rvec(a.R, b.X, b.Y, b.Z)
  return mkcf(a.X + x, a.Y + y, a.Z + z, rmul(a.R, b.R))
end
CF.__add = function(a, b) return mkcf(a.X + b.X, a.Y + b.Y, a.Z + b.Z, a.R) end
CF.__sub = function(a, b) return mkcf(a.X - b.X, a.Y - b.Y, a.Z - b.Z, a.R) end
CF.__tostring = function(c) local t = { c.X, c.Y, c.Z } for i = 1, 9 do t[#t + 1] = c.R[i] end for i = 1, #t do t[i] = tostring(t[i]) end return table.concat(t, ', ') end
function CF.Inverse(c) local r = rT(c.R) local x, y, z = rvec(r, -c.X, -c.Y, -c.Z) return mkcf(x, y, z, r) end
function CF.ToWorldSpace(a, b) return a * b end
function CF.ToObjectSpace(a, b) return a:Inverse() * b end
function CF.PointToWorldSpace(a, v) return a * v end
function CF.PointToObjectSpace(a, v) return a:Inverse() * v end
function CF.VectorToWorldSpace(a, v) local x, y, z = rvec(a.R, v.X, v.Y, v.Z) return v3(x, y, z) end
function CF.GetComponents(c) return c.X, c.Y, c.Z, unpack(c.R) end
CF.components = CF.GetComponents
function CF.ToOrientation(c)
  local r = c.R
  local x = math.asin(math.clamp(-r[6], -1, 1))
  return x, math.atan(r[3], r[9]), math.atan(r[4], r[5])
end
function CF.ToEulerAnglesXYZ(c)
  local r = c.R
  local y = math.asin(math.clamp(r[3], -1, 1))
  return math.atan(-r[6], r[9]), y, math.atan(-r[2], r[1])
end
local function ortho(r)
  local a = v3(r[1], r[4], r[7]).Unit
  local b = v3(r[2], r[5], r[8])
  b = (b - a * a:Dot(b)).Unit
  local c = a:Cross(b)
  return { a.X, b.X, c.X, a.Y, b.Y, c.Y, a.Z, b.Z, c.Z }
end
function CF.Lerp(a, b, t)
  local r = {}
  for i = 1, 9 do r[i] = a.R[i] + (b.R[i] - a.R[i]) * t end
  return mkcf(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t, ortho(r))
end

UDim2 = { new = function(a, b, c, d) return { __v = 'U2', XS = a or 0, XO = b or 0, YS = c or 0, YO = d or 0 } end,
  fromScale = function(a, b) return UDim2.new(a, 0, b, 0) end, fromOffset = function(a, b) return UDim2.new(0, a, 0, b) end }
NumberRange = { new = function(a, b) return { Min = a, Max = b or a } end }
Random = { new = function(seed)
  local r = {}
  function r:NextNumber(a, b) a, b = a or 0, b or 1 return a + math.random() * (b - a) end
  function r:NextInteger(a, b) return math.random(a, b) end
  return r
end }
TweenInfo = { new = function(t, style, dir, repeats, reverses, delayTime)
  return { Time = t or 1, EasingStyle = style, EasingDirection = dir, RepeatCount = repeats or 0, Reverses = reverses or false, DelayTime = delayTime or 0 }
end }

-- ---------- Enums ----------
local ENUMS = {
  Material = __ENUM_MATERIAL,
  PartType = { Ball = 0, Block = 1, Cylinder = 2, Wedge = 3, CornerWedge = 4 },
  EasingStyle = { Linear = 0, Sine = 1, Back = 2, Quad = 3, Quart = 4, Quint = 5, Bounce = 6, Elastic = 7, Exponential = 8, Circular = 9, Cubic = 10 },
  EasingDirection = { In = 0, Out = 1, InOut = 2 },
  HumanoidStateType = { Dead = 15, Jumping = 3, Running = 8, Freefall = 5, Landed = 7 },
  KeyCode = { E = 101, F = 102, Space = 32, W = 119, A = 97, S = 115, D = 100, Q = 113, R = 114 },
  UserInputType = { MouseButton1 = 0, Touch = 7, Keyboard = 8 },
  NormalId = { Right = 0, Top = 1, Back = 2, Left = 3, Bottom = 4, Front = 5 },
}
local EI = { __type = 'EnumItem' }
EI.__index = EI
EI.__tostring = function(e) return 'Enum.' .. e.EnumType .. '.' .. e.Name end
Enum = {}
for tname, items in pairs(ENUMS) do
  local et = {}
  for name, value in pairs(items) do et[name] = setmetatable({ Name = name, Value = value, EnumType = tname }, EI) end
  et.GetEnumItems = function() local o = {} for _, v in pairs(et) do if type(v) == 'table' then o[#o + 1] = v end end return o end
  Enum[tname] = et
end

-- ---------- signals ----------
local SIG = { __type = 'RBXScriptSignal' }
SIG.__index = SIG
local signals = {}
local function getSignal(id, name)
  local s = signals[id]
  if not s then s = {} signals[id] = s end
  local sig = s[name]
  if not sig then sig = setmetatable({ conns = {}, waiting = {} }, SIG) s[name] = sig end
  return sig
end
function SIG.Connect(sig, fn)
  local c = { fn = fn, Connected = true }
  function c.Disconnect(self) self.Connected = false for i, x in ipairs(sig.conns) do if x == c then table.remove(sig.conns, i) break end end end
  c.disconnect = c.Disconnect
  sig.conns[#sig.conns + 1] = c
  return c
end
SIG.connect = SIG.Connect
function SIG.Once(sig, fn) local c c = sig:Connect(function(...) c:Disconnect() fn(...) end) return c end
function SIG.Wait(sig)
  local co = coroutine.running()
  sig.waiting[#sig.waiting + 1] = co
  return coroutine.yield()
end
SIG.wait = SIG.Wait
local function fireSig(sig, ...)
  for _, c in ipairs({ table.unpack(sig.conns) }) do if c.Connected then task.spawn(c.fn, ...) end end
  local w = sig.waiting
  sig.waiting = {}
  for _, co in ipairs(w) do if coroutine.status(co) == 'suspended' then resume(co, ...) end end
end
local function newSignal() return setmetatable({ conns = {}, waiting = {} }, SIG) end

local EVENTS = { Touched = true, TouchEnded = true, Changed = true, ChildAdded = true, ChildRemoved = true, DescendantAdded = true,
  DescendantRemoving = true, Heartbeat = true, Stepped = true, RenderStepped = true, PlayerAdded = true, PlayerRemoving = true,
  CharacterAdded = true, CharacterRemoving = true, Died = true, HealthChanged = true, MouseClick = true, Triggered = true,
  Destroying = true, AncestryChanged = true, InputBegan = true, InputEnded = true, Running = true, Jumping = true, StateChanged = true,
  Activated = true, Equipped = true, Unequipped = true, MoveToFinished = true }

-- ---------- instances ----------
local INST = { __type = 'Instance' }
local proxies = {}
local attrs = {}
local function wrap(id)
  local p = proxies[id]
  if p then return p end
  p = setmetatable({ __id = id }, INST)
  proxies[id] = p
  return p
end

local function enc(v)
  local t = typeof(v)
  if t == 'Instance' then return { __i = v.__id } end
  if t == 'Vector3' then return { __v = 'V3', v.X, v.Y, v.Z } end
  if t == 'Color3' then return { __v = 'C3', v.R, v.G, v.B } end
  if t == 'BrickColor' then return { __v = 'C3', v.Color.R, v.Color.G, v.Color.B } end
  if t == 'CFrame' then local r = v.R return { __v = 'CF', v.X, v.Y, v.Z, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9] } end
  if t == 'EnumItem' then return { __v = 'EN', v.EnumType, v.Name, v.Value } end
  if t == 'Vector2' then return { __v = 'V2', v.X, v.Y } end
  return v
end
local function dec(v)
  if type(v) ~= 'table' then return v end
  if v.__i then return wrap(v.__i) end
  local k = v.__v
  if k == 'V3' then return v3(v[1], v[2], v[3]) end
  if k == 'C3' then return Color3.new(v[1], v[2], v[3]) end
  if k == 'CF' then return mkcf(v[1], v[2], v[3], { v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12] }) end
  if k == 'V2' then return Vector2.new(v[1], v[2]) end
  if k == 'EN' then local e = Enum[v[1]] return (e and e[v[2]]) or setmetatable({ Name = v[2], Value = v[3], EnumType = v[1] }, EI) end
  if k == 'BC' then return BrickColor.new(v[1]) end
  if k == 'ARR' then local o = {} for i = 1, #v do o[i] = dec(v[i]) end return o end
  return v
end
local function callJS(id, m, ...)
  local args = table.pack(...)
  for i = 1, args.n do args[i] = enc(args[i]) end
  return dec(__call(id, m, unpack(args, 1, args.n)))
end

local M = {}
function M.Destroy(self) local s = signals[self.__id] if s and s.Destroying then fireSig(s.Destroying) end callJS(self.__id, 'Destroy') end
M.Remove = M.Destroy
function M.Clone(self) return callJS(self.__id, 'Clone') end
function M.ClearAllChildren(self) callJS(self.__id, 'ClearAllChildren') end
function M.GetChildren(self) return callJS(self.__id, 'GetChildren') end
M.getChildren = M.GetChildren
M.children = M.GetChildren
function M.GetDescendants(self) return callJS(self.__id, 'GetDescendants') end
function M.FindFirstChild(self, n, rec) return callJS(self.__id, 'FindFirstChild', n, rec or false) end
M.findFirstChild = M.FindFirstChild
function M.FindFirstChildOfClass(self, c) return callJS(self.__id, 'FindFirstChildOfClass', c) end
function M.FindFirstChildWhichIsA(self, c, rec) return callJS(self.__id, 'FindFirstChildWhichIsA', c, rec or false) end
function M.FindFirstAncestor(self, n) return callJS(self.__id, 'FindFirstAncestor', n) end
function M.FindFirstAncestorOfClass(self, c) return callJS(self.__id, 'FindFirstAncestorOfClass', c) end
function M.FindFirstAncestorWhichIsA(self, c) return callJS(self.__id, 'FindFirstAncestorWhichIsA', c) end
function M.IsA(self, c) return callJS(self.__id, 'IsA', c) end
function M.IsDescendantOf(self, o) return callJS(self.__id, 'IsDescendantOf', o) end
function M.IsAncestorOf(self, o) return callJS(o.__id, 'IsDescendantOf', self) end
function M.GetFullName(self) return callJS(self.__id, 'GetFullName') end
function M.GetService(self, n) return callJS(self.__id, 'GetService', n) end
M.service = M.GetService
M.FindService = M.GetService
function M.WaitForChild(self, n, timeout)
  local start = __now()
  while true do
    local c = M.FindFirstChild(self, n)
    if c then return c end
    if timeout and __now() - start > timeout then return nil end
    task.wait(0.05)
  end
end
function M.GetPropertyChangedSignal(self, p) return getSignal(self.__id, 'Changed:' .. p) end
function M.SetAttribute(self, k, v)
  local a = attrs[self.__id] or {} attrs[self.__id] = a
  a[k] = v
  fireSig(getSignal(self.__id, 'Attr:' .. k))
end
function M.GetAttribute(self, k) local a = attrs[self.__id] return a and a[k] end
function M.GetAttributes(self) return table.clone(attrs[self.__id] or {}) end
function M.GetAttributeChangedSignal(self, k) return getSignal(self.__id, 'Attr:' .. k) end
function M.TakeDamage(self, n) self.Health = self.Health - n end
function M.GetPlayers(self) return callJS(self.__id, 'GetPlayers') end
function M.GetPlayerFromCharacter(self, c) return callJS(self.__id, 'GetPlayerFromCharacter', c) end
function M.GetPivot(self) return callJS(self.__id, 'GetPivot') end
function M.PivotTo(self, cf) callJS(self.__id, 'PivotTo', cf) end
function M.SetPrimaryPartCFrame(self, cf) callJS(self.__id, 'PivotTo', cf) end
function M.MoveTo(self, pos) callJS(self.__id, 'MoveTo', pos) end
function M.ApplyImpulse(self, v) callJS(self.__id, 'ApplyImpulse', v) end
function M.LoadCharacter(self) callJS(self.__id, 'LoadCharacter') end
function M.GetMouse(self) return {} end
function M.AddItem(self, inst, t) task.delay(t or 10, function() if inst.Parent then inst:Destroy() end end) end
function M.Kick(self, msg) __print('Kicked: ' .. tostring(msg or ''), 'warn') callJS(self.__id, 'Kick') end
function M.Create(self, inst, info, goals)
  -- TweenService:Create
  local tw = { Completed = newSignal(), PlaybackState = 'Begin' }
  local playing = false
  local function ease(t)
    local s = info.EasingStyle and info.EasingStyle.Name or 'Quad'
    local d = info.EasingDirection and info.EasingDirection.Name or 'Out'
    local function f(x)
      if s == 'Linear' then return x elseif s == 'Sine' then return 1 - cos(x * math.pi / 2)
      elseif s == 'Cubic' then return x * x * x elseif s == 'Quart' then return x ^ 4 elseif s == 'Quint' then return x ^ 5
      elseif s == 'Back' then return x * x * (2.70158 * x - 1.70158)
      elseif s == 'Exponential' then return x == 0 and 0 or 2 ^ (10 * x - 10)
      elseif s == 'Bounce' then local y = 1 - x local n, dd = 7.5625, 2.75
        if y < 1 / dd then y = n * y * y elseif y < 2 / dd then y = y - 1.5 / dd y = n * y * y + .75 elseif y < 2.5 / dd then y = y - 2.25 / dd y = n * y * y + .9375 else y = y - 2.625 / dd y = n * y * y + .984375 end
        return 1 - y
      end
      return x * x
    end
    if d == 'In' then return f(t) elseif d == 'Out' then return 1 - f(1 - t) end
    if t < .5 then return f(t * 2) / 2 end
    return 1 - f((1 - t) * 2) / 2
  end
  local function lerp(a, b, t)
    if type(a) == 'number' then return a + (b - a) * t end
    if a.Lerp then return a:Lerp(b, t) end
    return t < 1 and a or b
  end
  function tw:Play()
    if playing then return end
    playing = true
    tw.PlaybackState = 'Playing'
    task.spawn(function()
      if info.DelayTime and info.DelayTime > 0 then task.wait(info.DelayTime) end
      local reps = info.RepeatCount or 0
      repeat
        local from = {}
        for k in pairs(goals) do from[k] = inst[k] end
        local legs = info.Reverses and 2 or 1
        for leg = 1, legs do
          local start = __now()
          while playing do
            local t = math.clamp((__now() - start) / math.max(info.Time, 1e-3), 0, 1)
            local e = ease(t)
            for k, g in pairs(goals) do
              if leg == 1 then inst[k] = lerp(from[k], g, e) else inst[k] = lerp(g, from[k], e) end
            end
            if t >= 1 then break end
            task.wait()
          end
        end
        reps = reps - 1
      until (reps < 0 and (info.RepeatCount or 0) >= 0) or not playing
      if playing then tw.PlaybackState = 'Completed' playing = false fireSig(tw.Completed, Enum.EasingStyle.Linear) end
    end)
  end
  function tw:Cancel() playing = false tw.PlaybackState = 'Cancelled' end
  function tw:Pause() playing = false tw.PlaybackState = 'Paused' end
  return tw
end

INST.__index = function(self, k)
  local m = M[k]
  if m then return m end
  if EVENTS[k] then return getSignal(self.__id, k) end
  local found, v = __get(self.__id, k)
  if found then return dec(v) end
  error(tostring(k) .. ' is not a valid member of ' .. tostring(self), 2)
end
INST.__newindex = function(self, k, v)
  local ok, err = __set(self.__id, k, enc(v))
  if not ok then error(err, 2) end
  local s = signals[self.__id]
  if s then
    local sig = s['Changed:' .. k]
    if sig then fireSig(sig) end
    if s.Changed then fireSig(s.Changed, k) end
  end
end
INST.__tostring = function(self) local ok, n = __get(self.__id, 'Name') return n end
INST.__eq = function(a, b) return rawequal(a, b) end

Instance = {}
function Instance.new(cls, parent)
  local id = __new(cls)
  if not id then error('Unable to create an Instance of type "' .. tostring(cls) .. '"', 2) end
  local p = wrap(id)
  if parent then p.Parent = parent end
  return p
end

-- JS -> Lua event entry point
function __fire(id, name, ...)
  local s = signals[id]
  if not s then return end
  local sig = s[name]
  if not sig then return end
  local args = table.pack(...)
  for i = 1, args.n do args[i] = dec(args[i]) end
  fireSig(sig, unpack(args, 1, args.n))
end
-- Value objects: JS reports script-independent changes
function __changed(id, prop)
  local s = signals[id]
  if not s then return end
  local sig = s['Changed:' .. prop]
  if sig then fireSig(sig) end
  if s.Changed then fireSig(s.Changed, prop) end
end

-- ---------- script loading ----------
local modules = {}
function __run(id, src, chunk)
  local env = setmetatable({ script = wrap(id) }, { __index = _G, __newindex = _G })
  local f, err = load(src, '=' .. chunk, 't', env)
  if not f then __print(tostring(err), 'error') return end
  task.spawn(f)
end
function require(m)
  if type(m) ~= 'table' or not m.__id then error('Attempted to call require with invalid argument(s).', 2) end
  local id = m.__id
  if modules[id] ~= nil then return modules[id] end
  local src, chunk = callJS(id, '__source')
  local env = setmetatable({ script = m }, { __index = _G, __newindex = _G })
  local f, err = load(src, '=' .. chunk, 't', env)
  if not f then error(err, 2) end
  local res = f()
  modules[id] = res == nil and true or res
  return res
end

game = wrap(__GAME)
Game = game
workspace = wrap(__WORKSPACE)
Workspace = workspace
shared = {}
_G.shared = shared
`;
