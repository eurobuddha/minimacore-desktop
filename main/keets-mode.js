"use strict";

const { nodeTokens } = require("./keymode");

// ParamConfigurer.usingProgramArgs uses the last -keets and its optional value.
function enabledInArgs(argv) {
  const tokens = nodeTokens(argv);
  const pos = tokens.lastIndexOf("-keets");
  if (pos < 0) return false;
  const value = tokens[pos + 1];
  return value === undefined || value.startsWith("-") || value === "true";
}
module.exports = { enabledInArgs };
