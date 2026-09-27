import type { PairOutcome } from '../lib/session';
import { rig } from './harness';

const REPORTABLE: PairOutcome[] = [
  { kind: 'permissionDenied' },
  { kind: 'pairingFailed' },
  { kind: 'timeout' },
  { kind: 'notificationsFailed' },
  { kind: 'notificationsFailed', message: 'le bond dropped' },
  { kind: 'error', message: 'boom' },
];

const CHOSEN: PairOutcome[] = [{ kind: 'connected' }, { kind: 'cancelled' }];

describe('pair outcome copy', () => {
  test('every outcome the user did not choose reports something', () => {
    const r = rig({ platform: 'ios' });

    for (const outcome of REPORTABLE) {
      const notice = r.session.describePairOutcome(outcome);
      expect(notice).not.toBeNull();
      expect(notice?.title.length).toBeGreaterThan(0);
      expect(notice?.body.length).toBeGreaterThan(0);
    }
  });

  test('an outcome the user chose reports nothing', () => {
    const r = rig({ platform: 'ios' });

    for (const outcome of CHOSEN)
      expect(r.session.describePairOutcome(outcome)).toBeNull();
  });

  test('a native message reaches the body instead of being dropped', () => {
    const r = rig({ platform: 'ios' });

    expect(
      r.session.describePairOutcome({ kind: 'error', message: 'boom' })?.body,
    ).toBe('boom');
    expect(
      r.session.describePairOutcome({
        kind: 'notificationsFailed',
        message: 'le bond dropped',
      })?.body,
    ).toBe('le bond dropped');
  });

  test('copy stays lowercase on both the title and the action', () => {
    const r = rig({ platform: 'ios' });

    for (const outcome of REPORTABLE) {
      const notice = r.session.describePairOutcome(outcome);
      expect(notice?.title).toBe(notice?.title.toLowerCase());
      if (notice?.action)
        expect(notice.action.label).toBe(notice.action.label.toLowerCase());
    }
  });

  test('a timeout reads the same on both platforms', () => {
    const ios = rig({ platform: 'ios' });
    const android = rig({ platform: 'android' });

    expect(ios.session.describePairOutcome({ kind: 'timeout' })).toEqual(
      android.session.describePairOutcome({ kind: 'timeout' }),
    );
  });
});

describe('pair picker recovery', () => {
  test('a dismissed ios picker offers a way out of the bonded dead end', async () => {
    const r = rig({ platform: 'ios' });
    r.native.__returns.set('presentPairPicker', { kind: 'cancelled' });

    const result = await r.session.presentPairWithGuidance();

    expect(result.picked).toBe(false);
    expect(result.notice?.action).toEqual({
      kind: 'openSettings',
      label: 'open settings',
    });
  });

  test('a picked device carries no recovery', async () => {
    const r = rig({ platform: 'ios' });
    r.native.__returns.set('presentPairPicker', { kind: 'picked', device: { id: 'dev', name: 'thing' } });

    expect(await r.session.presentPairWithGuidance()).toEqual({
      picked: true,
      notice: null,
    });
  });

  test('android has no bonded dead end to recover from', () => {
    const r = rig({ platform: 'android' });

    expect(r.session.describePairPickerDismissed()).toBeNull();
  });
});
