// Colour sets for the 3D shop. "herbal" = warm wood, bamboo and leaf green for a herbal-tea shop;
// "kawaii" = the original pink Chibi grocery.

export interface ShopTheme {
  id: "herbal" | "kawaii";
  floorPlankA: string;
  floorPlankB: string;
  floorLine: string;
  floorGrain: string;
  rug: string;
  rugBorder: string;
  wallA: string;
  wallB: string;
  wainscot: string | null; // lower wall panelling (bamboo slats) or none
  wainscotLine: string;
  wallTrim: string;
  baseboard: string;
  shelf: string;
  shelfEdge: string;
  counter: string;
  counterTop: string;
  sign: string;
  signBorder: string;
  signText: string;
  signShadow: string;
  tagBorder: string;
  tagText: string;
  jars: string[];
  jarLid: string;
  doorMat: string;
  background: string;
  ambient: string;
  hemiSky: string;
  hemiGround: string;
  sun: string;
  fill: string;
  wallHeight: number;
}

export const THEMES: Record<ShopTheme["id"], ShopTheme> = {
  herbal: {
    id: "herbal",
    floorPlankA: "#b98352",
    floorPlankB: "#ad7747",
    floorLine: "#7d522f",
    floorGrain: "rgba(90,50,20,0.22)",
    rug: "#dcc48f",
    rugBorder: "#5f8a4a",
    wallA: "#f6eed9",
    wallB: "#f1e6cb",
    wainscot: "#d9bf86",
    wainscotLine: "#b39253",
    wallTrim: "#3f6b3f",
    baseboard: "#6b4a2b",
    shelf: "#caa06a",
    shelfEdge: "#8d6037",
    counter: "#8a5a34",
    counterTop: "#e6cf98",
    sign: "#3b2a1a",
    signBorder: "#e8c46a",
    signText: "#f6d98a",
    signShadow: "rgba(0,0,0,0.45)",
    tagBorder: "#3f6b3f",
    tagText: "#2f3b22",
    // dried herbs in glass jars: chrysanthemum, green tea, artichoke, goji, lotus, ginger
    jars: ["#e2b437", "#7d9c45", "#5d3b22", "#b84a32", "#c99a8f", "#c98a3a"],
    jarLid: "#c49a62",
    doorMat: "#6b8f4e",
    background: "linear-gradient(#e7efd8, #f7efdc)",
    ambient: "#fff8ec",
    hemiSky: "#fbf6e6",
    hemiGround: "#b98a5a",
    sun: "#fff3dc",
    fill: "#e9f3dc",
    wallHeight: 3.0,
  },
  kawaii: {
    id: "kawaii",
    floorPlankA: "#e9b98a",
    floorPlankB: "#dfa977",
    floorLine: "#c48a5c",
    floorGrain: "rgba(160,100,60,0.18)",
    rug: "#ff9ebd",
    rugBorder: "#ffffff",
    wallA: "#ffd6e3",
    wallB: "#ffe7ee",
    wainscot: null,
    wainscotLine: "#ffffff",
    wallTrim: "#e2779c",
    baseboard: "#c95f86",
    shelf: "#f4c58f",
    shelfEdge: "#d99a5e",
    counter: "#7fd1b9",
    counterTop: "#ffffff",
    sign: "#ff6f9f",
    signBorder: "#ffffff",
    signText: "#ffffff",
    signShadow: "rgba(150,30,80,0.45)",
    tagBorder: "#e2779c",
    tagText: "#4a2b3c",
    jars: ["#ff8fb1", "#6fd3c2", "#ffd166", "#a78bfa", "#7cc6ff", "#ff9f5a"],
    jarLid: "#ffffff",
    doorMat: "#ff8fb1",
    background: "linear-gradient(#ffd9e6, #fff1e0)",
    ambient: "#fff4f8",
    hemiSky: "#fff2f7",
    hemiGround: "#e7b48c",
    sun: "#fff6ea",
    fill: "#ffd9ec",
    wallHeight: 2.6,
  },
};

export const themeOf = (id: string | undefined): ShopTheme => THEMES[id === "kawaii" ? "kawaii" : "herbal"];
