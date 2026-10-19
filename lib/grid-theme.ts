import { colorSchemeDark, themeQuartz } from "ag-grid-community";

/**
 * AG Grid theme built from the CoinBane palette using the Theming API
 * (AG Grid v33+). No `ag-grid-community/styles/*.css` imports — those belong
 * to the deprecated legacy theming path.
 *
 * Client-only: this module pulls in browser code.
 */
export const coinbaneGridTheme = themeQuartz
  .withPart(colorSchemeDark)
  .withParams({
    backgroundColor: "#131923",
    foregroundColor: "#F1F4F8",
    chromeBackgroundColor: "#0E121A",
    accentColor: "#4B9CFF",
    borderColor: "#242C38",
    oddRowBackgroundColor: "#181F2B",
    headerTextColor: "#8994A6",
    fontSize: 13,
    fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
    borderRadius: 0,
    wrapperBorder: false,
  });
