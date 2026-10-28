import * as Network from 'expo-network';

import { isPrivateIPv4 } from './discovery';

/**
 * 從網路狀態判斷手機在不在區網裡，在的話回傳手機的區網位址。
 * 不能只看網路類型：開著 Tailscale 等 VPN 時，iOS 會把類型回報成 UNKNOWN（VPN 介面排在 Wi-Fi 前面），
 * 但 Wi-Fi 其實還連著。所以改看 Wi-Fi 網卡（en0）上有沒有私人網段的位址；用 4G 時 Wi-Fi 網卡沒有位址，不會誤掃電信商的網段。
 */
export function lanIpFrom(type: string | undefined, ip: string | null | undefined): string | null {
  if (type === 'NONE') return null;
  if (!ip || ip === '0.0.0.0') return null;
  return isPrivateIPv4(ip) ? ip : null;
}

/** 手機在 Wi-Fi（或有線）區網時回傳手機位址，否則回 null */
export async function wifiIp(): Promise<string | null> {
  const state = await Network.getNetworkStateAsync();
  const ip = await Network.getIpAddressAsync();
  return lanIpFrom(state.type, ip);
}
