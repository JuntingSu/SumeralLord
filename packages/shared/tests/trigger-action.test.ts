// 战役触发器 Phase 1：动作事务（增量 diff / 连锁 / 排序 / once / AI 不触发 / 延时排期 / 溢出）。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '../src/index.js';
import type { MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, chainKinds, force, makeMap } from './helpers.js';

const THREE_PLAYERS = [
  { seat: 1, team: 1 },
  { seat: 2, team: 2 },
  { seat: 3, team: 3 },
];

function campaignMap(triggers: TriggerDef[], tiles: Record<number, [number, number, number]>): MapFullData {
  return {
    ...makeMap({ rows: 3, columns: 3, players: THREE_PLAYERS, tiles }),
    trigger_schema_version: 2,
    triggers,
  };
}

function start(triggers: TriggerDef[], tiles: Record<number, [number, number, number]> = { 0: [PLAIN, 1, 1] }) {
  return initState({
    map: campaignMap(triggers, tiles),
    seatAssignments: assignments(
      { seat: 1, playerId: 1 },
      { seat: 2, playerId: 2 },
      { seat: 3, playerId: 3 },
    ),
    timeSettings: DEFAULT_TIME,
    seed: 'trigger-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });

describe('action triggers', () => {
  it('fires on tile occupation and records intentSeq', () => {
    const state = start([
      {
        id: 'occupy',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 't', text: 'occupied', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chainKinds(r)).toContain('TRIGGER_FIRE');
    expect(chainKinds(r)).toContain('TRIGGER_TEXT_SHOW');
    expect(r.state.triggerRuntime?.firedCounts.occupy).toBe(1);
    expect(r.state.triggerRuntime?.intentSeq).toBe(1);
  });

  it('fires on tile vacated and force gone, including chain', () => {
    const state = start([
      {
        id: 'vacate',
        when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 'null' },
        effects: [{ op: 'show_text', text_id: 'v', text: 'vacated', placement: { kind: 'screen', position: 'top-right' } }],
      },
      {
        id: 'clear',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'clear_force', force: 2 }],
      },
      {
        id: 'gone',
        when: { op: 'force_gone', force: 2 },
        effects: [{ op: 'show_text', text_id: 'g', text: 'gone', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(force(r.state, 2).alive).toBe(false);
    expect(r.state.triggerRuntime?.firedCounts).toMatchObject({ vacate: 1, clear: 1, gone: 1 });
    expect(chainKinds(r)).toContain('FORCE_CLEAR');
  });

  it('supports trigger_fired chain and priority ordering', () => {
    const state = start([
      {
        id: 'low',
        priority: 0,
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 'low', text: 'low', placement: { kind: 'screen', position: 'top-right' } }],
      },
      {
        id: 'high',
        priority: 10,
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 'high', text: 'high', placement: { kind: 'screen', position: 'top-right' } }],
      },
      {
        id: 'after-high',
        priority: 5,
        when: { op: 'trigger_fired', trigger_id: 'high' },
        effects: [{ op: 'show_text', text_id: 'after', text: 'after', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fired = r.chain
      .filter((e): e is Extract<typeof e, { kind: 'TRIGGER_FIRE' }> => e.kind === 'TRIGGER_FIRE')
      .map((e) => e.triggerId);
    expect(fired).toEqual(['high', 'after-high', 'low']);
  });

  it('once fires at most once per game', () => {
    const state = start(
      [
        {
          id: 'once',
          once: true,
          when: {
            op: 'or',
            items: [
              { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
              { op: 'tile_owner_changed', tile: 4, from: 'any', to: 1 },
            ],
          },
          effects: [{ op: 'show_text', text_id: 'o', text: 'once', placement: { kind: 'screen', position: 'top-right' } }],
        },
      ],
      { 0: [PLAIN, 1, 1], 3: [PLAIN, 1, 1] },
    );
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.triggerRuntime?.firedCounts.once).toBe(1);

    const second = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(3, 4) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(chainKinds(second)).not.toContain('TRIGGER_FIRE');
    expect(second.state.triggerRuntime?.firedCounts.once).toBe(1);
  });

  it('does not fire action triggers for AI intents', () => {
    const state = start([
      {
        id: 'occupy',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 't', text: 'occupied', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'AI', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chainKinds(r)).not.toContain('TRIGGER_FIRE');
    expect(r.state.triggerRuntime?.firedCounts).toEqual({});
    expect(r.state.triggerRuntime?.intentSeq).toBe(0);
  });

  it('schedules delayed triggers instead of executing them', () => {
    const state = start([
      {
        id: 'delayed',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        delay: { amount: 1, unit: 'intent' },
        effects: [{ op: 'show_text', text_id: 'd', text: 'delayed', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chainKinds(r)).not.toContain('TRIGGER_FIRE');
    expect(r.state.triggerRuntime?.pending).toHaveLength(1);
    expect(r.state.triggerRuntime?.pending[0].dueIntentSeq).toBe(2);
  });

  it('caps runaway repeatable chains with TRIGGER_OVERFLOW', () => {
    const state = start([
      {
        id: 'starter',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 's', text: 'starter', placement: { kind: 'screen', position: 'top-right' } }],
      },
      {
        id: 'loop',
        repeatable: true,
        when: { op: 'trigger_fired', trigger_id: 'starter' },
        effects: [{ op: 'show_text', text_id: 'l', text: 'loop', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chainKinds(r)).toContain('TRIGGER_OVERFLOW');
    expect(r.state.triggerRuntime?.firedCounts.loop).toBeGreaterThan(400);
  });
});
