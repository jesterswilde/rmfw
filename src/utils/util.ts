export const load = async (path: string, type: "json" | "text") => {
  try {
    const response = await fetch(path);
    if (response.ok) {
      if(type === "text")
        return await response.text();
      else 
        return await response.json();
    } else {
      throw new Error(`Error loading: ${path}`);
    }
  } catch (error) {
    console.error(error);
  }
};