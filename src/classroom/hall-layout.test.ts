import { describe, expect, it } from 'vitest';
import { CMO_RADIUS, MAX_HALF_WIDTH, ROW_PITCH, STAGE_RZ, VIEW_W, layoutHall } from './hall-layout';

const team = (n: number) => Array.from({ length: n }, (_, i) => `agent_${i}`);
const SIZES = [0, 1, 7, 8, 12, 25, 60];

describe('classroom hall layout', () => {
  it('stands the desk figure alone on the floor between the stage lip and the first ring, facing the room', () => {
    for (const n of SIZES) {
      const { rows, rings } = layoutHall('cmo', team(n));
      const [desk, ...teamRows] = rows;
      expect(desk.ring).toBe(false);
      expect(desk.seats).toHaveLength(1);
      expect(desk.seats[0]).toMatchObject({ agent: 'cmo', facing: true });
      expect(CMO_RADIUS).toBeGreaterThan(STAGE_RZ);
      expect(CMO_RADIUS).toBeLessThan(rings[0].radius);
      expect(teamRows.every((row) => row.ring && row.seats.every((seat) => !seat.facing))).toBe(true);
    }
  });

  it('seats the team from the first ring outward, in order, filling each row before the next', () => {
    for (const n of SIZES) {
      const { rows, rings } = layoutHall('cmo', team(n));
      const teamRows = rows.slice(1);
      expect(teamRows[0].radius).toBe(rings[0].radius);
      expect(teamRows.flatMap((row) => row.seats.flatMap((seat) => (seat.agent ? [seat.agent] : [])))).toEqual(team(n));
      for (const row of teamRows.slice(0, -1)) expect(row.seats.every((seat) => seat.agent)).toBe(true);
    }
  });

  it('centres a partly filled row on the aisle', () => {
    const { rows } = layoutHall('cmo', team(3));
    const occupied = rows[1].seats.flatMap((seat, i) => (seat.agent ? [i] : []));
    const capacity = rows[1].seats.length;
    expect(occupied[0]).toBe(Math.floor((capacity - 3) / 2));
    expect(occupied).toEqual([occupied[0], occupied[0] + 1, occupied[0] + 2]);
  });

  it('always draws one empty ring beyond the last seated row', () => {
    for (const n of SIZES) {
      const { rows, rings } = layoutHall('cmo', team(n));
      const teamRows = rows.slice(1);
      expect(rings.map((ring) => ring.radius)).toEqual([...teamRows.map((row) => row.radius), teamRows[teamRows.length - 1].radius + ROW_PITCH]);
    }
    expect(layoutHall('cmo', []).rings).toHaveLength(2);
  });

  it('keeps every seat within the hall width (rows are fitted on their ring; seats sit just outside it)', () => {
    for (const n of SIZES) {
      for (const row of layoutHall('cmo', team(n)).rows) {
        for (const seat of row.seats) expect(Math.abs(seat.slot.x - VIEW_W / 2)).toBeLessThan(MAX_HALF_WIDTH + 10);
      }
    }
  });

  it('frames a small team with the same camera, so the stage and desk do not move as people join', () => {
    const empty = layoutHall('cmo', []);
    for (const n of [1, 7, 8]) {
      const hall = layoutHall('cmo', team(n));
      expect(hall.rows[0].seats[0].slot).toEqual(empty.rows[0].seats[0].slot);
      expect(hall.stage).toEqual(empty.stage);
    }
  });
});
