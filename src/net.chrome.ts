// Chrome target: re-export CDP-based capture as the canonical ./net module.
export {
  installNetworkCapture,
  readNetwork,
  clearNetwork,
  addStream,
  removeStream,
  attachAll,
} from "./network";
