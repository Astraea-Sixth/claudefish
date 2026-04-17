'use strict';

// Example hook. Copy & modify. Exports any of: preMessage, postMessage, preTool, postTool.

module.exports = {
  async preMessage({ userId, userText }) {
    console.log(`[hook] u=${userId} in=${String(userText).slice(0, 80)}`);
  },
  async postTool({ name, isError }) {
    if (isError) console.log(`[hook] tool ${name} errored`);
  }
};
