// Shared store layout for unit tests (matches the demo shop).

import type { StoreLayout } from "../types/protocol";

export function shelf(code: string, x: number, z: number) {
  const front = z + 0.3 + 0.55;
  return {
    code,
    name: code,
    transform: { x, z, rot: 0, w: 2.4, d: 0.6, h: 1.6 },
    stand_positions: [-0.7, 0, 0.7].map((dx) => ({ x: x + dx, z: front })),
    wait_positions: [{ x: x - 1.75, z: front }, { x: x + 1.75, z: front }],
    slots: [-0.7, 0, 0.7].map((dx, i) => ({
      code: `S${i + 1}`,
      product_id: code === "KE_02" && i === 1 ? "TRA_CA_GAI_LEO" : code === "KE_03" && i === 1 ? "TRA_BA_KICH" : null,
      local: { x: dx, y: 0.55, z: 0.18 },
    })),
  };
}

export const LAYOUT: StoreLayout = {
  version: 1,
  store: { width: 12, depth: 16, door: { x: 0, z: 7.6 }, counter: { x: 0, z: -6.6, w: 3.2, d: 0.8 } },
  shelves: [
    shelf("KE_01", -3, -3.5), shelf("KE_02", 3, -3.5), shelf("KE_03", -3, 0),
    shelf("KE_04", 3, 0), shelf("KE_05", -3, 3.5), shelf("KE_06", 3, 3.5),
  ],
  products: [
    { id: "TRA_CA_GAI_LEO", sku: "DEMO-TCGL-01", name: "Trà cà gai leo", price: 85000, currency: "VND", image_url: null, box_size: { w: 0.2, h: 0.28, d: 0.08 } },
    { id: "TRA_BA_KICH", sku: "DEMO-TBK-01", name: "Trà ba kích", price: null, currency: "VND", image_url: null, box_size: { w: 0.2, h: 0.28, d: 0.08 } },
  ],
};

