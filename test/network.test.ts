import { lanIpFrom, vpnFrom } from '../src/lib/network';

test.each([
  ['WIFI', '192.168.1.23', '192.168.1.23'],
  ['UNKNOWN', '192.168.1.23', '192.168.1.23'], // 開著 Tailscale：iOS 回報 UNKNOWN，但 Wi-Fi 網卡有區網位址
  ['VPN', '10.0.0.8', '10.0.0.8'],
  ['CELLULAR', '0.0.0.0', null], // 用 4G：Wi-Fi 網卡沒有位址
  ['UNKNOWN', '0.0.0.0', null], // 4G＋Tailscale
  ['NONE', '192.168.1.23', null],
  ['WIFI', '100.64.1.2', null], // 不是私人網段
  ['WIFI', '', null],
  [undefined, null, null],
])('網路類型 %s、位址 %s → %s', (type, ip, expected) => {
  expect(lanIpFrom(type as string | undefined, ip)).toBe(expected);
});

test('手機有沒有開 VPN：iOS 開著時回報 VPN 或 UNKNOWN', () => {
  expect(vpnFrom('UNKNOWN')).toBe(true);
  expect(vpnFrom('VPN')).toBe(true);
  expect(vpnFrom('CELLULAR')).toBe(false);
  expect(vpnFrom('WIFI')).toBe(false);
  expect(vpnFrom(undefined)).toBeNull();
});
