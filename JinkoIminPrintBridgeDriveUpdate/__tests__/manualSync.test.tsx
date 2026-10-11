import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Alert, AppState, NativeModules, Pressable, Text} from 'react-native';
import {afterEach, beforeEach, expect, jest, test} from '@jest/globals';

const settings = {
  apiBaseUrl: 'https://bridge.test.invalid',
  shopName: 'Test shop',
  drinkCategory: 'เครื่องดื่ม',
  kitchenHost: '192.168.1.242',
  kitchenPort: 9100,
  pollSeconds: 6,
  autoPrint: true,
  skipExistingOnFirstSync: true,
  printerMode: 'imin',
  counterHost: '',
  counterPort: 9100,
  bluetoothAddress: '',
  bluetoothName: '',
};
const printer = {
  getSettings: jest.fn(async () => settings),
  getPrintedKeys: jest.fn(async (): Promise<string[]> => []),
  hasCompletedBootstrap: jest.fn(async () => true),
  getInternalPrinterStatus: jest.fn(async () => ({
    code: 0,
    ready: true,
    message: 'Ready',
  })),
  claimPrint: jest.fn(async (_key: string) => true),
  releasePrint: jest.fn(async (_key: string) => {}),
  markPrinted: jest.fn(async (_key: string) => {}),
  markBootstrapCompleted: jest.fn(async () => {}),
  clearPrintedKeys: jest.fn(async () => {}),
  printInternal: jest.fn(async (_ticket: unknown) => ({ok: true})),
  printNetwork: jest.fn(
    async (_ticket: unknown, _host: string, _port: number, _cut: boolean) => ({
      ok: true,
    }),
  ),
};
NativeModules.IminPrinter = printer;
// Load App after installing the native mock; production endpoints are never contacted.
const App = require('../App').default;

const order = {
  id: 'manual-order',
  table: 3,
  status: 'pending',
  createdAt: '2026-10-11T03:30:00Z',
  items: [
    {name: 'ชาเย็น', category: 'เครื่องดื่ม', qty: 1},
    {name: 'ข้าวผัด', category: 'อาหาร', qty: 2},
  ],
};
const mockFetch = jest.fn(async (url: string, _init?: RequestInit) => {
  const endpoint = new URL(url).pathname;
  if (endpoint === '/api/orders') return {ok: true, json: async () => [order]};
  if (endpoint === '/api/print-jobs')
    return {ok: true, json: async () => ({jobs: []})};
  if (endpoint === '/api/settings')
    return {ok: true, json: async () => ({paperWidthMm: 80})};
  if (endpoint === '/api/shop-status')
    return {ok: true, json: async () => ({specialOpenDate: null})};
  throw new Error(`Unexpected mocked request: ${endpoint}`);
});
const originalFetch = global.fetch;
let screen: renderer.ReactTestRenderer | undefined;

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function mount() {
  await act(async () => {
    screen = renderer.create(<App />);
    await settle();
  });
}
function button(label: string) {
  return screen!.root
    .findAllByType(Pressable)
    .find(node =>
      node.findAllByType(Text).some(text => text.props.children === label),
    )!;
}
function queueCalls(path: string) {
  return mockFetch.mock.calls.filter(([url]) => new URL(url).pathname === path);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-11T10:31:00+07:00'));
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
  });
  printer.getSettings.mockResolvedValue(settings);
  printer.hasCompletedBootstrap.mockResolvedValue(true);
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  act(() => screen?.unmount());
  screen = undefined;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('automatic startup and timer at 10:31 emit no requests', async () => {
  await mount();
  await act(async () => {
    jest.advanceTimersByTime(12_000);
    await settle();
  });
  expect(mockFetch).not.toHaveBeenCalled();
  expect(printer.printInternal).not.toHaveBeenCalled();
  expect(printer.printNetwork).not.toHaveBeenCalled();
});

test.each(['2026-10-11', '2026-10-12'])(
  'one manual click at 10:31 on %s fetches and prints both routes only once',
  async day => {
    jest.setSystemTime(new Date(`${day}T10:31:00+07:00`));
    await mount();
    mockFetch.mockClear();
    await act(async () => {
      await button('ซิงก์ตอนนี้').props.onPress();
      await settle();
    });
    expect(queueCalls('/api/orders')).toHaveLength(1);
    expect(queueCalls('/api/print-jobs')).toHaveLength(1);
    expect(queueCalls('/api/printer-status')).toHaveLength(0);
    expect(printer.printInternal).toHaveBeenCalledTimes(1);
    expect(printer.printInternal).toHaveBeenCalledWith(
      expect.objectContaining({items: [{name: 'ชาเย็น', qty: 1}]}),
    );
    expect(printer.printNetwork).toHaveBeenCalledTimes(1);
    expect(printer.printNetwork).toHaveBeenCalledWith(
      expect.objectContaining({items: [{name: 'ข้าวผัด', qty: 2}]}),
      settings.kitchenHost,
      9100,
      true,
    );
    expect(printer.markPrinted).toHaveBeenCalledWith('internal:manual-order');
    expect(printer.markPrinted).toHaveBeenCalledWith('kitchen:manual-order');
    expect(
      screen!.root
        .findAllByType(Text)
        .some(text => text.props.children === 'ดึงมือนอกเวลาเปิดร้าน'),
    ).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(12_000);
      await settle();
    });
    expect(queueCalls('/api/orders')).toHaveLength(1);
    expect(queueCalls('/api/print-jobs')).toHaveLength(1);
    expect(printer.printInternal).toHaveBeenCalledTimes(1);
    expect(printer.printNetwork).toHaveBeenCalledTimes(1);

    await act(async () => {
      await button('ซิงก์ตอนนี้').props.onPress();
      await settle();
    });
    expect(queueCalls('/api/orders')).toHaveLength(2);
    expect(queueCalls('/api/print-jobs')).toHaveLength(2);
    expect(printer.printInternal).toHaveBeenCalledTimes(1);
    expect(printer.printNetwork).toHaveBeenCalledTimes(1);
  },
);

test('clear-history confirmation also performs one manual sync outside hours', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mount();
  button('ล้างประวัติ เพื่อพิมพ์คิวปัจจุบันใหม่').props.onPress();
  const confirm = alert.mock.calls[0][2]![1].onPress!;
  await act(async () => {
    await confirm();
    await settle();
  });
  expect(printer.clearPrintedKeys).toHaveBeenCalledTimes(1);
  expect(queueCalls('/api/orders')).toHaveLength(1);
  expect(queueCalls('/api/print-jobs')).toHaveLength(1);
});

test('manual sync retains the existing autoPrint off setting', async () => {
  printer.getSettings.mockResolvedValue({...settings, autoPrint: false});
  await mount();
  await act(async () => {
    await button('ซิงก์ตอนนี้').props.onPress();
    await settle();
  });
  expect(queueCalls('/api/orders')).toHaveLength(1);
  expect(queueCalls('/api/print-jobs')).toHaveLength(1);
  expect(printer.printInternal).not.toHaveBeenCalled();
  expect(printer.printNetwork).not.toHaveBeenCalled();
});

test('manual sync retains first-sync skipExisting protection', async () => {
  printer.hasCompletedBootstrap.mockResolvedValue(false);
  await mount();
  await act(async () => {
    await button('ซิงก์ตอนนี้').props.onPress();
    await settle();
  });
  expect(queueCalls('/api/orders')).toHaveLength(1);
  expect(queueCalls('/api/print-jobs')).toHaveLength(1);
  expect(printer.markBootstrapCompleted).toHaveBeenCalledTimes(1);
  expect(printer.printInternal).not.toHaveBeenCalled();
  expect(printer.printNetwork).not.toHaveBeenCalled();
});
