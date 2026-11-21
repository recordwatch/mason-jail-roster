// Site color palette. Every page's <style> starts with THEME_VARS, and CSS
// refers to colors as var(--name), so changing a color here changes it everywhere.
// Base swatches: gold #DAAF60, khaki #A49A69, olive #556548, teal #1D403A, ink #092530.
export const COLORS = {
  bg: '#092530',          // page background (ink)
  card: '#0E2F38',        // cards, rows, inputs
  cardDeep: '#0C2A33',    // stat tiles inside cards
  border: '#1D403A',      // borders and dividers (teal)
  hover: '#556548',       // button hover, buttons, bars (olive)
  hoverLight: '#6B7A5A',  // hover on olive buttons
  muted: '#A49A69',       // labels, timestamps (khaki)
  text: '#D6D0B4',        // body text
  head: '#F2EBD3',        // headings, names (cream)
  accent: '#DAAF60',      // links, numbers, highlights (gold)
  released: '#C9BD8A',    // released badge and row edge
  mapNone: '#143840',     // county with no online roster
  mapNoneEdge: '#24483F',
  mapRoster: '#24483F',   // county with a roster link
  mapRosterEdge: '#35594F',
  mapMonitored: '#7F8F5C' // county we actively monitor
};

export const PIE_CHART_COLORS = ['#DAAF60', '#556548', '#A49A69', '#2E6355', '#F2EBD3', '#8C7A3E', '#7F9468', '#C9BD8A', '#3F7A6B', '#6E5A2E'];

const toVar = (k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export const THEME_VARS = `:root { ${Object.entries(COLORS).map(([k, v]) => `${toVar(k)}: ${v};`).join(' ')} }`;
