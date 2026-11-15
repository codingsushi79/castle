import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./lib/store";

function Root() {
  const accent = useApp((s) => s.settings.accent);
  const scheme = useApp((s) => s.settings.colorScheme);
  const prefersDark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = scheme === "auto" ? (prefersDark ? "dark" : "light") : scheme;
  const theme = createTheme({
    primaryColor: accent,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
    fontSizes: { xs: "11px", sm: "12.5px", md: "13.5px", lg: "16px", xl: "20px" },
    defaultRadius: "sm",
    components: {
      Button: { defaultProps: { size: "xs" } },
      ActionIcon: { defaultProps: { size: "md" } },
      Select: { defaultProps: { size: "xs", allowDeselect: false, comboboxProps: { transitionProps: { transition: "pop", duration: 120 } } } },
      TextInput: { defaultProps: { size: "xs" } },
      NumberInput: { defaultProps: { size: "xs" } },
      SegmentedControl: { defaultProps: { size: "xs" } },
      Switch: { defaultProps: { size: "xs" } },
      Checkbox: { defaultProps: { size: "xs" } },
      Tooltip: { defaultProps: { openDelay: 400, withArrow: true } },
      Modal: { defaultProps: { centered: true, transitionProps: { transition: "pop", duration: 160 } } },
    },
  });
  return (
    <MantineProvider theme={theme} forceColorScheme={resolved}>
      <Notifications position="bottom-right" />
      <App />
    </MantineProvider>
  );
}

if (import.meta.env.DEV) import("./dev");

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
