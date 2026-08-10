// Here to break the dependency from BashTool's prompt, which names this tool
// when steering shell scripts toward it. Importing CodeActTool.ts for the
// string would pull the whole sandbox graph into the Bash prompt path.
export const CODE_ACT_TOOL_NAME = 'CodeAct'
