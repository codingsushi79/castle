import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/notifications/styles.css";
import "../styles.css";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import ReactDOM from "react-dom/client";
import { installErrorReporting } from "../lib/errors";
import { WebApp } from "./WebApp";

const theme = createTheme({
  primaryColor: "teal",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
  defaultRadius: "sm",
  components: {
    Button: { defaultProps: { size: "xs" } },
    Select: { defaultProps: { size: "xs", allowDeselect: false } },
    TextInput: { defaultProps: { size: "xs" } },
    NumberInput: { defaultProps: { size: "xs" } },
    SegmentedControl: { defaultProps: { size: "xs" } },
    Switch: { defaultProps: { size: "xs" } },
    Tooltip: { defaultProps: { openDelay: 400, withArrow: true } },
  },
});

installErrorReporting();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <Notifications position="top-right" />
    <WebApp />
  </MantineProvider>,
);
