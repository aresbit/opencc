declare module '*.md' {
  const content: string
  export default content
}

declare module '*.py' {
  const content: string
  export default content
}

declare module '*.yaml' with { type: 'text' } {
  const content: string
  export default content
}
