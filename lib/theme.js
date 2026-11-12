/**
 * Theme tokens.
 * Colors follow the reference data-viz palette (validated for contrast and
 * color-vision-deficiency separation on these exact surfaces).
 * Text always wears ink tokens; series colors only ever appear as marks
 * (the area bar segments and their legend dots).
 */
export const THEMES = {
  light: {
    surface: '#fcfcfb',
    border: 'rgba(11,11,11,0.10)',
    inkPrimary: '#0b0b0b',
    inkSecondary: '#52514e',
    inkMuted: '#898781',
    hairline: '#e1e0d9',
    // categorical slots 1–3 + neutral "Other"
    series: ['#2a78d6', '#eb6834', '#1baf7a'],
    other: '#c3c2b7'
  },
  dark: {
    surface: '#1a1a19',
    border: 'rgba(255,255,255,0.10)',
    inkPrimary: '#f0efec',
    inkSecondary: '#c3c2b7',
    inkMuted: '#898781',
    hairline: '#2c2c2a',
    series: ['#3987e5', '#d95926', '#199e70'],
    other: '#52514e'
  }
};

export function getTheme(name) {
  return THEMES[name] || THEMES.light;
}
