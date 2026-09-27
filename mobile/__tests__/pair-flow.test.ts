import { DEVICE, peer } from './fixtures';
import { rig, type Rig } from './harness';

function answer(r: Rig, method: string, value: unknown): void {
  r.native.__returns.set(method, value);
}

function denyBluetooth(r: Rig): void {
  (r.permissions.request as unknown as jest.Mock).mockResolvedValue('blocked');
}

function alreadyPaired(r: Rig): void {
  r.emit('peerConnected', peer());
}

describe('pairing on ios', () => {
  test('a device that connects and takes notification pairing is paired', async () => {
    const r = rig({ platform: 'ios' });
    answer(r, 'presentPairPicker', { kind: 'picked', device: { id: DEVICE, name: 'Car Thing' } });
    answer(r, 'enableAncsNotifications', { kind: 'authorized' });
    alreadyPaired(r);

    expect(await r.session.runPairFlow()).toEqual({ kind: 'connected' });
  });

  test('dismissing the picker is a cancellation, not a failure', async () => {
    const r = rig({ platform: 'ios' });
    answer(r, 'presentPairPicker', { kind: 'cancelled' });

    expect(await r.session.runPairFlow()).toEqual({ kind: 'cancelled' });
  });

  test('notification pairing failing does not report the pairing as failed', async () => {
    const r = rig({ platform: 'ios' });
    answer(r, 'presentPairPicker', { kind: 'picked', device: { id: DEVICE, name: 'Car Thing' } });
    answer(r, 'enableAncsNotifications', { kind: 'failed', message: 'nope' });
    alreadyPaired(r);

    expect(await r.session.runPairFlow()).toEqual({
      kind: 'notificationsFailed',
      message: 'nope',
    });
  });

  test('a native failure is reported rather than thrown at the caller', async () => {
    const r = rig({ platform: 'ios' });
    answer(r, 'presentPairPicker', () => Promise.reject(new Error('boom')));

    expect(await r.session.runPairFlow()).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });
});

describe('pairing on android', () => {
  test('a bonded device that connects is paired', async () => {
    const r = rig({ platform: 'android' });
    answer(r, 'presentPairPicker', { kind: 'picked', device: { id: DEVICE, bondState: 'bonded' } });
    alreadyPaired(r);

    expect(await r.session.runPairFlow()).toEqual({ kind: 'connected' });
  });

  test('a device that never finishes bonding is a pairing failure', async () => {
    const r = rig({ platform: 'android' });
    answer(r, 'presentPairPicker', {
      kind: 'picked',
      device: { id: DEVICE, bondState: 'bonding' },
    });

    expect(await r.session.runPairFlow()).toEqual({ kind: 'pairingFailed' });
  });

  test('bluetooth off fails fast with a clear notice', async () => {
    const r = rig({ platform: 'android' });
    answer(r, 'presentPairPicker', { kind: 'bluetoothOff' });

    expect(await r.session.runPairFlow()).toEqual({ kind: 'bluetoothOff' });
    expect(
      r.session.describePairOutcome({ kind: 'bluetoothOff' })?.title,
    ).toBe('bluetooth is off');
  });

  test('no device found is reported instead of hanging', async () => {
    const r = rig({ platform: 'android' });
    answer(r, 'presentPairPicker', { kind: 'notFound' });

    expect(await r.session.runPairFlow()).toEqual({ kind: 'notFound' });
    expect(r.session.describePairOutcome({ kind: 'notFound' })?.title).toBe(
      'no car thing found',
    );
  });

  test('refusing bluetooth stops before the picker is presented', async () => {
    const r = rig({ platform: 'android' });
    denyBluetooth(r);
    answer(r, 'presentPairPicker', { kind: 'picked', device: { id: DEVICE, bondState: 'bonded' } });

    expect(await r.session.runPairFlow()).toEqual({ kind: 'permissionDenied' });
    expect(r.native.__calls).not.toContain('presentPairPicker');
  });

  test('android does not attempt notification pairing', async () => {
    const r = rig({ platform: 'android' });
    answer(r, 'presentPairPicker', { kind: 'picked', device: { id: DEVICE, bondState: 'bonded' } });
    answer(r, 'enableAncsNotifications', () => {
      throw new Error('ancs must not be reached on android');
    });
    alreadyPaired(r);

    expect(await r.session.runPairFlow()).toEqual({ kind: 'connected' });
  });
});
