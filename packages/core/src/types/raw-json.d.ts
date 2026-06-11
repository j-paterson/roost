// Vite `?raw` suffix imports the file contents as a string.
declare module "*.json?raw" {
  const content: string;
  export default content;
}
