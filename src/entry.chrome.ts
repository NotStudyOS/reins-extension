// Chrome MV3 entrypoint.
// Installs all capture hooks that depend on chrome.debugger, then starts the
// WS client defined in background.ts.
import { installNetworkCapture } from "./net.chrome";
import { installWsHook } from "./ws-capture";
import { installInterceptHook } from "./intercept";
import { init as installConsoleCapture } from "./console-log";

installNetworkCapture();
installWsHook();
installInterceptHook();
installConsoleCapture();

import "./background";
