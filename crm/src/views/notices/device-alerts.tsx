'use client';

import { BellOff, BellRing, CircleCheck, CircleSlash, Laptop, MonitorX, Smartphone, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DeviceAlertsApi, DeviceAlertsPreview, PushDeviceRow, PushDeviceState } from './device-alerts-types';
import { DEVICE_ALERT_TEXT, deviceStateLine, deviceStateWord, deviceSummary, effectiveDeviceState, testBlockedReason, turnOnBlockedReason } from './device-alerts-words';

/*
 * Bell settings › "Alerts on this device" (contract 15.8, 8.1–8.5; Release A,
 * track D). Per person, per device, opt-in: nothing is registered until the
 * person presses "Turn on alerts on this device". The state line says in
 * words what this browser can do (unsupported, iPhone needs the Home Screen,
 * blocked, off, on). Device list with the last alert date and "Remove";
 * "Send a test alert". 21st.dev ideas: "Notification Settings Field" (title,
 * description, one control per row) and "Item Action List" (row + one
 * action); built on the CRM kit (ACC3-DESIGN-NOTES.md).
 */

type Msg = { ok: boolean; text: string } | null;

export function DeviceAlertsSection({ api, pushEnabled, preview }: { api: DeviceAlertsApi | null; pushEnabled: boolean; preview?: DeviceAlertsPreview }) {
  const headingId = useId();
  const blockedId = useId();
  const [state, setState] = useState<PushDeviceState | null>(preview?.state ?? null);
  const [devices, setDevices] = useState<PushDeviceRow[] | null>(preview ? (preview.loading ? null : preview.devices) : null);
  const [loadError, setLoadError] = useState(!!preview?.loadError);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(preview?.message ?? null);
  const enabled = preview ? preview.pushEnabled : pushEnabled;

  const reload = useCallback(async () => {
    if (!api) return;
    const [s, l] = await Promise.all([api.detect().catch(() => 'unsupported' as const), api.list().catch(() => null)]);
    setState(s);
    if (l?.ok) {
      setDevices(l.data.devices);
      setLoadError(false);
    } else setLoadError(true);
  }, [api]);

  useEffect(() => {
    if (preview || !api || !enabled) return;
    let live = true;
    void (async () => {
      if (live) await reload();
    })();
    return () => {
      live = false;
    };
  }, [api, enabled, preview, reload]);

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>, okText: string) {
    if (busy) return;
    setBusy(key);
    try {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.message ?? okText } : { ok: false, text: r.message ?? 'Could not save — try again.' });
      if (r.ok && !preview) await reload();
    } catch {
      setMsg({ ok: false, text: 'Could not save — try again.' });
    } finally {
      setBusy(null);
    }
  }

  const s: PushDeviceState = effectiveDeviceState(state ?? 'off', loadError ? null : devices);
  const list = devices ?? [];
  const thisDevice = list.find((d) => d.thisDevice) ?? null;
  const blocked = turnOnBlockedReason(s, enabled, list);
  const testBlocked = testBlockedReason(devices, loadError);
  const testReasonId = `${blockedId}-test`;
  const noApi = !api && !preview;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={headingId} className="m-0 text-base font-semibold text-ink">
        {DEVICE_ALERT_TEXT.heading}: {deviceStateWord(s, enabled)}
      </h3>
      <p className="m-0 text-copy">{DEVICE_ALERT_TEXT.what}</p>
      {!enabled ? (
        <StateLine icon={BellOff} text={`${DEVICE_ALERT_TEXT.switchOff} The bell, sound and pop-ups work as before.`} />
      ) : state === null && !noApi ? (
        <p className="m-0 text-sm text-quiet" role="status">
          Checking this browser…
        </p>
      ) : (
        <StateLine icon={ICON[s]} text={deviceStateLine(s)} />
      )}

      <div className="flex flex-wrap items-start gap-2">
        {s === 'on' && enabled ? (
          <>
            <span className="inline-flex max-w-full flex-col items-start gap-1">
              <Button
                variant="secondary"
                aria-disabled={!!busy || !!testBlocked || undefined}
                aria-describedby={testBlocked ? testReasonId : undefined}
                onClick={() => (testBlocked ? undefined : thisDevice && api ? void run('test', () => api.test(thisDevice.deviceId), 'Test alert sent. It should arrive within a minute.') : preview ? setMsg({ ok: true, text: 'Synthetic preview: test alert sent.' }) : undefined)}
              >
                <Send aria-hidden="true" />
                {busy === 'test' ? 'Sending…' : DEVICE_ALERT_TEXT.test}
              </Button>
              {testBlocked ? (
                <span id={testReasonId} className="text-sm text-quiet">
                  {testBlocked}
                </span>
              ) : null}
            </span>
            <Button variant="ghost" aria-disabled={!!busy || undefined} onClick={() => (api ? void run('off', () => api.turnOff(), 'Alerts turned off on this device.') : preview ? setMsg({ ok: true, text: 'Synthetic preview: alerts turned off on this device.' }) : undefined)}>
              <BellOff aria-hidden="true" />
              {busy === 'off' ? 'Turning off…' : DEVICE_ALERT_TEXT.turnOff}
            </Button>
          </>
        ) : (
          <span className="inline-flex max-w-full flex-col items-start gap-1">
            <Button
              variant="secondary"
              aria-disabled={!!blocked || !!busy || noApi || undefined}
              aria-describedby={blocked || noApi ? blockedId : undefined}
              onClick={(e) => {
                if (blocked || busy || noApi) {
                  e.preventDefault();
                  return;
                }
                if (api) void run('on', () => api.turnOn(), 'Alerts turned on for this device.');
                else if (preview) setMsg({ ok: true, text: 'Synthetic preview: alerts turned on for this device.' });
              }}
            >
              <BellRing aria-hidden="true" />
              {busy === 'on' ? 'Turning on…' : DEVICE_ALERT_TEXT.turnOn}
            </Button>
            {blocked || noApi ? (
              <span id={blockedId} className="text-sm text-quiet">
                {blocked ?? 'Not available in this window.'}
              </span>
            ) : null}
          </span>
        )}
      </div>

      {enabled ? (
        <div className="flex flex-col gap-2 pt-1">
          <h4 className="m-0 text-sm font-semibold text-ink">
            {DEVICE_ALERT_TEXT.devicesHeading}
            {devices === null || loadError ? null : ` (${String(list.length)} of 10)`}
          </h4>
          {loadError ? (
            <p className="m-0 text-sm text-copy" role="alert">
              {DEVICE_ALERT_TEXT.loadFailed}
            </p>
          ) : devices === null ? (
            <p className="m-0 text-sm text-quiet" role="status">
              Loading your devices…
            </p>
          ) : list.length === 0 ? (
            <p className="m-0 text-sm text-quiet">{DEVICE_ALERT_TEXT.noDevices}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((d) => (
                <li key={d.deviceId} className="flex items-start justify-between gap-2 rounded-control border border-line px-3 py-2">
                  <span className="flex min-w-0 items-start gap-2">
                    {/phone|iphone|android/i.test(d.label) ? <Smartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" /> : <Laptop aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />}
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-semibold break-words text-ink">
                        {d.label}
                        {d.thisDevice ? <span className="font-normal text-copy"> (this device)</span> : null}
                      </span>
                      <span className="text-sm text-quiet">{deviceSummary(d)}</span>
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-label={`${DEVICE_ALERT_TEXT.remove} ${d.label}${d.thisDevice ? ' (this device)' : ''}`}
                    aria-disabled={!!busy || undefined}
                    onClick={() => (api ? void run(`rm:${d.deviceId}`, () => (d.thisDevice ? api.turnOff() : api.remove(d.deviceId)), d.thisDevice ? 'This device is removed and alerts are off here.' : `${d.label} removed. It gets no more alerts.`) : preview ? setMsg({ ok: true, text: `Synthetic preview: ${d.label} removed.` }) : undefined)}
                  >
                    <Trash2 aria-hidden="true" />
                    {busy === `rm:${d.deviceId}` ? 'Removing…' : DEVICE_ALERT_TEXT.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-sm text-quiet">{DEVICE_ALERT_TEXT.sharedComputer}</p>
        </div>
      ) : null}

      {msg ? (
        <p role={msg.ok ? 'status' : 'alert'} className="m-0 text-sm text-copy">
          <strong>{msg.ok ? 'Done: ' : 'Not saved: '}</strong>
          {msg.text}
        </p>
      ) : (
        <div role="status" className="contents" />
      )}
    </section>
  );
}

const ICON: Record<PushDeviceState, typeof BellOff> = {
  unsupported: MonitorX,
  needs_home_screen: Smartphone,
  blocked: CircleSlash,
  off: BellOff,
  on: CircleCheck,
};

function StateLine({ icon: Icon, text }: { icon: typeof BellOff; text: string }) {
  return (
    <p className="m-0 flex items-start gap-2 rounded-control border border-line bg-wash px-3 py-2 text-sm text-copy">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-quiet" />
      <span>
        <span className="sr-only">This device: </span>
        {text}
      </span>
    </p>
  );
}
