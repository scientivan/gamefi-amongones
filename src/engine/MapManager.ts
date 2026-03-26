export enum RoomType {
  ENGINE_ROOM = "Engine Room",
  WEAPONS_TOP = "Weapons (Top)",
  WEAPONS_BOTTOM = "Weapons (Bottom)",
  MEDBAY = "MedBay",
  CAFETERIA = "Cafeteria",
  STORAGE = "Storage",
  ADMIN = "Admin",
  NAVIGATION = "Navigation",
  BRIDGE = "Bridge",
  SHIELDS = "Shields",
  HALLWAY = "Hallway",
}

export interface Room {
  id: RoomType;
  connections: RoomType[];
  hasVent: boolean;
  hasTask: boolean;
}

export const SPACESHIP_MAP: Record<RoomType, Room> = {
  [RoomType.ENGINE_ROOM]: {
    id: RoomType.ENGINE_ROOM,
    connections: [RoomType.WEAPONS_TOP, RoomType.WEAPONS_BOTTOM],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.WEAPONS_TOP]: {
    id: RoomType.WEAPONS_TOP,
    connections: [RoomType.ENGINE_ROOM, RoomType.CAFETERIA, RoomType.MEDBAY],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.WEAPONS_BOTTOM]: {
    id: RoomType.WEAPONS_BOTTOM,
    connections: [RoomType.ENGINE_ROOM, RoomType.STORAGE],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.MEDBAY]: {
    id: RoomType.MEDBAY,
    connections: [RoomType.WEAPONS_TOP, RoomType.CAFETERIA],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.CAFETERIA]: {
    id: RoomType.CAFETERIA,
    connections: [
      RoomType.WEAPONS_TOP,
      RoomType.MEDBAY,
      RoomType.STORAGE,
      RoomType.ADMIN,
      RoomType.NAVIGATION,
    ],
    hasVent: false,
    hasTask: true,
  },
  [RoomType.ADMIN]: {
    id: RoomType.ADMIN,
    connections: [RoomType.CAFETERIA, RoomType.STORAGE, RoomType.NAVIGATION],
    hasVent: false,
    hasTask: true,
  },
  [RoomType.STORAGE]: {
    id: RoomType.STORAGE,
    connections: [
      RoomType.WEAPONS_BOTTOM,
      RoomType.CAFETERIA,
      RoomType.ADMIN,
      RoomType.SHIELDS,
    ],
    hasVent: false,
    hasTask: true,
  },
  [RoomType.NAVIGATION]: {
    id: RoomType.NAVIGATION,
    connections: [
      RoomType.CAFETERIA,
      RoomType.ADMIN,
      RoomType.BRIDGE,
      RoomType.SHIELDS,
    ],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.BRIDGE]: {
    id: RoomType.BRIDGE,
    connections: [RoomType.NAVIGATION, RoomType.SHIELDS],
    hasVent: false,
    hasTask: true,
  },
  [RoomType.SHIELDS]: {
    id: RoomType.SHIELDS,
    connections: [RoomType.STORAGE, RoomType.NAVIGATION, RoomType.BRIDGE],
    hasVent: true,
    hasTask: true,
  },
  [RoomType.HALLWAY]: {
    id: RoomType.HALLWAY,
    connections: [],
    hasVent: false,
    hasTask: false,
  },
};

// ---------------------------------------------------------------------------
// Waypoint network — every point is in % matching the frontend ROOM_COORDS
// coordinate space (x: 0-100 left→right, y: 0-100 top→bottom).
// Room centres are the "anchor" waypoints where characters linger.
// Corridor waypoints sit at doorways / bends so the path follows the hallways
// visible in amongones-map.webp.
// ---------------------------------------------------------------------------

interface Pos {
  x: number;
  y: number;
}

/** Centre of each room (linger targets). Must match frontend ROOM_COORDS. */
const ROOM_CENTER: Record<RoomType, Pos> = {
  [RoomType.ENGINE_ROOM]: { x: 10, y: 50 },
  [RoomType.WEAPONS_TOP]: { x: 22, y: 22 },
  [RoomType.WEAPONS_BOTTOM]: { x: 22, y: 75 },
  [RoomType.MEDBAY]: { x: 34, y: 40 },
  [RoomType.CAFETERIA]: { x: 50, y: 20 },
  [RoomType.STORAGE]: { x: 48, y: 65 },
  [RoomType.ADMIN]: { x: 60, y: 48 },
  [RoomType.NAVIGATION]: { x: 73, y: 18 },
  [RoomType.SHIELDS]: { x: 73, y: 72 },
  [RoomType.BRIDGE]: { x: 92, y: 50 },
  [RoomType.HALLWAY]: { x: 50, y: 50 },
};

/**
 * Corridor waypoints for each directed edge A→B.
 * These are the intermediate points the character walks through between
 * leaving room A's centre and arriving at room B's centre.
 * Key is "A|B". The array does NOT include A's centre or B's centre —
 * those are prepended / appended automatically.
 *
 * Designed by tracing the hallways in amongones-map.webp:
 *   - Left side:  Engine ↔ WeaponsTop  via left vertical corridor
 *   - Left side:  Engine ↔ WeaponsBot  via left vertical corridor
 *   - Top:        WeaponsTop ↔ Cafeteria  via upper corridor
 *   - Mid-left:   WeaponsTop ↔ MedBay  short horizontal
 *   - Mid-left:   MedBay ↔ Cafeteria  via doorway
 *   - Center:     Cafeteria ↔ Storage  via central vertical corridor
 *   - Center:     Cafeteria ↔ Admin  via central junction
 *   - Right-top:  Cafeteria ↔ Navigation  via top corridor
 *   - Center:     Storage ↔ Admin  short horizontal
 *   - Center-bot: Storage ↔ WeaponsBot  via left-lower corridor
 *   - Center-bot: Storage ↔ Shields  via lower corridor
 *   - Right:      Admin ↔ Navigation  short vertical
 *   - Right:      Navigation ↔ Bridge  via right corridor
 *   - Right-bot:  Navigation ↔ Shields  via right vertical
 *   - Far-right:  Shields ↔ Bridge  via right corridor
 */
const CORRIDOR_WAYPOINTS: Record<string, Pos[]> = {
  // ── Engine Room ↔ Weapons Top ──
  // Exit Engine Room to the RIGHT, go UP along left vertical corridor,
  // then enter Weapons Top from the bottom-left.
  // Map trace: EngineRoom(10,50) → doorway(16,50) → corridor(16,40) → corridor(16,30) → WeaponsTop(22,22)
  [`${RoomType.ENGINE_ROOM}|${RoomType.WEAPONS_TOP}`]: [
    { x: 16, y: 50 },
    { x: 16, y: 40 },
    { x: 16, y: 30 },
  ],
  [`${RoomType.WEAPONS_TOP}|${RoomType.ENGINE_ROOM}`]: [
    { x: 16, y: 30 },
    { x: 16, y: 40 },
    { x: 16, y: 50 },
  ],

  // ── Engine Room ↔ Weapons Bottom ──
  // Exit Engine Room to the RIGHT, go DOWN along left vertical corridor,
  // then enter Weapons Bottom from the top-left.
  // Map trace: EngineRoom(10,50) → doorway(16,50) → corridor(16,60) → corridor(16,68) → WeaponsBot(22,75)
  [`${RoomType.ENGINE_ROOM}|${RoomType.WEAPONS_BOTTOM}`]: [
    { x: 16, y: 50 },
    { x: 16, y: 60 },
    { x: 16, y: 68 },
  ],
  [`${RoomType.WEAPONS_BOTTOM}|${RoomType.ENGINE_ROOM}`]: [
    { x: 16, y: 68 },
    { x: 16, y: 60 },
    { x: 16, y: 50 },
  ],

  // ── Weapons Top ↔ MedBay ──
  // Exit Weapons Top to the right-bottom, go RIGHT into MedBay.
  // There's a short horizontal corridor connecting them.
  // Map trace: WeaponsTop(22,22) → exit(24,30) → corridor(28,34) → MedBay(34,40)
  [`${RoomType.WEAPONS_TOP}|${RoomType.MEDBAY}`]: [
    { x: 24, y: 30 },
    { x: 28, y: 34 },
  ],
  [`${RoomType.MEDBAY}|${RoomType.WEAPONS_TOP}`]: [
    { x: 28, y: 34 },
    { x: 24, y: 30 },
  ],

  // ── Weapons Top ↔ Cafeteria ──
  // Exit Weapons Top to the RIGHT, follow the upper corridor going RIGHT along the top.
  // Map trace: WeaponsTop(22,22) → exit-right(26,16) → corridor(32,12) → corridor(38,12) → Cafeteria(50,20)
  [`${RoomType.WEAPONS_TOP}|${RoomType.CAFETERIA}`]: [
    { x: 26, y: 16 },
    { x: 32, y: 12 },
    { x: 38, y: 12 },
  ],
  [`${RoomType.CAFETERIA}|${RoomType.WEAPONS_TOP}`]: [
    { x: 38, y: 12 },
    { x: 32, y: 12 },
    { x: 26, y: 16 },
  ],

  // ── MedBay ↔ Cafeteria ──
  // Exit MedBay upward, go UP and slightly RIGHT into Cafeteria's lower-left side.
  // Map trace: MedBay(34,40) → doorway(36,32) → Cafeteria(50,20)
  [`${RoomType.MEDBAY}|${RoomType.CAFETERIA}`]: [
    { x: 36, y: 32 },
    { x: 40, y: 26 },
  ],
  [`${RoomType.CAFETERIA}|${RoomType.MEDBAY}`]: [
    { x: 40, y: 26 },
    { x: 36, y: 32 },
  ],

  // ── Cafeteria ↔ Storage ──
  // Exit Cafeteria from the bottom, go DOWN through the central vertical corridor to Storage.
  // Map trace: Cafeteria(50,20) → exit-bottom(44,30) → corridor(40,42) → corridor(40,54) → Storage(48,65)
  [`${RoomType.CAFETERIA}|${RoomType.STORAGE}`]: [
    { x: 44, y: 30 },
    { x: 40, y: 42 },
    { x: 40, y: 54 },
  ],
  [`${RoomType.STORAGE}|${RoomType.CAFETERIA}`]: [
    { x: 40, y: 54 },
    { x: 40, y: 42 },
    { x: 44, y: 30 },
  ],

  // ── Cafeteria ↔ Admin ──
  // Exit Cafeteria from the bottom-right, go DOWN-RIGHT through a corridor to Admin.
  // Map trace: Cafeteria(50,20) → exit(54,28) → corridor(56,36) → Admin(60,48)
  [`${RoomType.CAFETERIA}|${RoomType.ADMIN}`]: [
    { x: 54, y: 28 },
    { x: 56, y: 36 },
  ],
  [`${RoomType.ADMIN}|${RoomType.CAFETERIA}`]: [
    { x: 56, y: 36 },
    { x: 54, y: 28 },
  ],

  // ── Cafeteria ↔ Navigation ──
  // Exit Cafeteria to the RIGHT, follow the top corridor going RIGHT to Navigation.
  // Map trace: Cafeteria(50,20) → corridor(58,14) → corridor(64,14) → Navigation(73,18)
  [`${RoomType.CAFETERIA}|${RoomType.NAVIGATION}`]: [
    { x: 58, y: 14 },
    { x: 64, y: 14 },
  ],
  [`${RoomType.NAVIGATION}|${RoomType.CAFETERIA}`]: [
    { x: 64, y: 14 },
    { x: 58, y: 14 },
  ],

  // ── Weapons Bottom ↔ Storage ──
  // Exit Weapons Bottom to the RIGHT, follow the lower corridor going RIGHT to Storage.
  // Map trace: WeaponsBot(22,75) → exit(27,78) → corridor(34,75) → corridor(40,72) → Storage(48,65)
  [`${RoomType.WEAPONS_BOTTOM}|${RoomType.STORAGE}`]: [
    { x: 27, y: 78 },
    { x: 34, y: 75 },
    { x: 40, y: 72 },
  ],
  [`${RoomType.STORAGE}|${RoomType.WEAPONS_BOTTOM}`]: [
    { x: 40, y: 72 },
    { x: 34, y: 75 },
    { x: 27, y: 78 },
  ],

  // ── Storage ↔ Admin ──
  // Exit Storage to the upper-right, short corridor UP-RIGHT to Admin.
  // Map trace: Storage(48,65) → corridor(54,58) → Admin(60,48)
  [`${RoomType.STORAGE}|${RoomType.ADMIN}`]: [{ x: 54, y: 58 }],
  [`${RoomType.ADMIN}|${RoomType.STORAGE}`]: [{ x: 54, y: 58 }],

  // ── Storage ↔ Shields ──
  // Exit Storage to the RIGHT, follow the lower corridor going RIGHT to Shields.
  // Map trace: Storage(48,65) → corridor(55,70) → corridor(63,74) → Shields(73,72)
  [`${RoomType.STORAGE}|${RoomType.SHIELDS}`]: [
    { x: 55, y: 70 },
    { x: 63, y: 74 },
  ],
  [`${RoomType.SHIELDS}|${RoomType.STORAGE}`]: [
    { x: 63, y: 74 },
    { x: 55, y: 70 },
  ],

  // ── Admin ↔ Navigation ──
  // Exit Admin to the top, short corridor going UP to Navigation.
  // Map trace: Admin(60,48) → corridor(64,38) → corridor(68,26) → Navigation(73,18)
  [`${RoomType.ADMIN}|${RoomType.NAVIGATION}`]: [
    { x: 64, y: 38 },
    { x: 68, y: 26 },
  ],
  [`${RoomType.NAVIGATION}|${RoomType.ADMIN}`]: [
    { x: 68, y: 26 },
    { x: 64, y: 38 },
  ],

  // ── Navigation ↔ Bridge ──
  // Exit Navigation to the RIGHT, go RIGHT-DOWN through the right corridor to Bridge.
  // Map trace: Navigation(73,18) → corridor(80,20) → corridor(84,34) → Bridge(92,50)
  [`${RoomType.NAVIGATION}|${RoomType.BRIDGE}`]: [
    { x: 80, y: 20 },
    { x: 84, y: 34 },
  ],
  [`${RoomType.BRIDGE}|${RoomType.NAVIGATION}`]: [
    { x: 84, y: 34 },
    { x: 80, y: 20 },
  ],

  // ── Navigation ↔ Shields ──
  // Exit Navigation downward, go DOWN through right vertical corridor to Shields.
  // Map trace: Navigation(73,18) → corridor(72,32) → corridor(72,48) → corridor(72,60) → Shields(73,72)
  [`${RoomType.NAVIGATION}|${RoomType.SHIELDS}`]: [
    { x: 72, y: 32 },
    { x: 72, y: 48 },
    { x: 72, y: 60 },
  ],
  [`${RoomType.SHIELDS}|${RoomType.NAVIGATION}`]: [
    { x: 72, y: 60 },
    { x: 72, y: 48 },
    { x: 72, y: 32 },
  ],

  // ── Shields ↔ Bridge ──
  // Exit Shields to the RIGHT, go RIGHT-UP through the right corridor to Bridge.
  // Map trace: Shields(73,72) → corridor(80,68) → corridor(84,58) → Bridge(92,50)
  [`${RoomType.SHIELDS}|${RoomType.BRIDGE}`]: [
    { x: 80, y: 68 },
    { x: 84, y: 58 },
  ],
  [`${RoomType.BRIDGE}|${RoomType.SHIELDS}`]: [
    { x: 84, y: 58 },
    { x: 80, y: 68 },
  ],
};

/** Build the full waypoint path for a directed edge: [roomA_center, ...corridor, roomB_center] */
function buildPath(from: RoomType, to: RoomType): Pos[] {
  const key = `${from}|${to}`;
  const mid = CORRIDOR_WAYPOINTS[key] || [];
  return [ROOM_CENTER[from], ...mid, ROOM_CENTER[to]];
}

// ---------------------------------------------------------------------------
// Per-player movement state (internal to MapManager)
// ---------------------------------------------------------------------------
interface PlayerMovement {
  room: RoomType; // current logical room (updates when path completes)
  pos: Pos; // current interpolated position
  path: Pos[]; // remaining waypoints to walk toward (next target is [0])
  idleTimer: number; // ticks remaining before picking a new destination
  isControlled?: boolean; // If true, automation skips this player
}

// How many % units the character moves per tick (100 ms).
// 6 per 1s = 0.6 per 100ms → same distance/s.
const MOVE_SPEED = 0.6;

// How long (ticks) a character lingers in a room before picking a new destination.
// Randomised per-idle between MIN and MAX.
// At 100ms ticks: 20 ticks = 2s, 50 ticks = 5s.
const IDLE_MIN = 20;
const IDLE_MAX = 50;

export class MapManager {
  private players: Record<string, PlayerMovement> = {};

  constructor() {}

  // ── Public API ──────────────────────────────────────────────────────────

  public spawnPlayer(playerId: string) {
    const center = ROOM_CENTER[RoomType.CAFETERIA];
    this.players[playerId] = {
      room: RoomType.CAFETERIA,
      pos: { ...center },
      path: [],
      idleTimer: 0,
    };
  }

  public setControlled(playerId: string, controlled: boolean) {
    if (this.players[playerId]) {
      this.players[playerId].isControlled = controlled;
      this.players[playerId].path = []; // clear any automated path
    }
  }

  public setPosition(playerId: string, x: number, y: number) {
    if (this.players[playerId]) {
      this.players[playerId].pos = { x, y };
      // room is updated by logic or separate call, but let's update it here too for safety
      this.players[playerId].room = this.getRoomAt(x, y);
    }
  }

  /** Advance all players one tick (call once per second from GameEngine). */
  public tickMovement() {
    for (const id of Object.keys(this.players)) {
      this.tickPlayer(id);
    }
  }

  /** Get the current (x, y) position of a player in %. */
  public getPosition(playerId: string): Pos {
    return this.players[playerId]?.pos ?? ROOM_CENTER[RoomType.CAFETERIA];
  }

  /** Get the current logical room of a player. */
  public getRoom(playerId: string): RoomType {
    return this.players[playerId]?.room ?? RoomType.CAFETERIA;
  }

  /** Freeze a player in place (e.g. when killed). They stop moving permanently. */
  public stopPlayer(playerId: string) {
    const p = this.players[playerId];
    if (!p) return;
    p.path = [];
    p.idleTimer = 999999; // effectively infinite
  }

  /** Remove a player (e.g. on reset). */
  public removePlayer(playerId: string) {
    delete this.players[playerId];
  }

  // Legacy helpers still used by GameEngine for kill-logic (same-room check)
  public getAdjacentRooms(room: RoomType): RoomType[] {
    if (!SPACESHIP_MAP[room]) return [];
    return SPACESHIP_MAP[room].connections;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private tickPlayer(id: string) {
    const p = this.players[id];
    if (!p) return;

    // Controlled players do not move automatically
    if (p.isControlled) return;

    // If we have waypoints to walk toward, advance.
    if (p.path.length > 0) {
      const target = p.path[0];
      const dx = target.x - p.pos.x;
      const dy = target.y - p.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= MOVE_SPEED) {
        // Arrived at this waypoint — snap and pop.
        p.pos = { ...target };
        p.path.shift();

        // If path is now empty we've reached the destination room centre.
        if (p.path.length === 0) {
          // Update logical room to the destination
          // (the last waypoint we snapped to IS the room centre we targeted)
          p.room = this.getRoomAt(p.pos.x, p.pos.y);
          p.idleTimer =
            IDLE_MIN + Math.floor(Math.random() * (IDLE_MAX - IDLE_MIN + 1));
        }
      } else {
        // Move toward target at MOVE_SPEED per tick.
        const ratio = MOVE_SPEED / dist;
        p.pos = {
          x: p.pos.x + dx * ratio,
          y: p.pos.y + dy * ratio,
        };
      }
      return;
    }

    // Idle: count down, then pick a new destination.
    if (p.idleTimer > 0) {
      p.idleTimer--;
      return;
    }

    // Pick a random adjacent room and build the corridor path.
    this.pickNewDestination(id);
  }

  private pickNewDestination(id: string) {
    const p = this.players[id];
    if (!p) return;

    const connections = SPACESHIP_MAP[p.room]?.connections;
    if (!connections || connections.length === 0) return;

    const target = connections[Math.floor(Math.random() * connections.length)];
    const fullPath = buildPath(p.room, target);

    // Drop the first element (current room centre — we're already there).
    p.path = fullPath.slice(1);
  }

  /** Given a position, find which room centre it matches (or closest). */
  public getRoomAt(x: number, y: number): RoomType {
    const pos = { x, y };
    let best: RoomType = RoomType.CAFETERIA;
    let bestDist = Infinity;
    for (const [room, centre] of Object.entries(ROOM_CENTER) as [
      RoomType,
      Pos,
    ][]) {
      const dx = pos.x - centre.x;
      const dy = pos.y - centre.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = room;
      }
    }
    return best;
  }
}
