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

export async function createShader( gpu: GPUDevice, file: string): Promise<GPUShaderModule> {
  const code = await load(file, "text");
  const module = gpu.createShaderModule({ code });

  const info = await module.getCompilationInfo();
  if (info.messages.length > 0) {
    for (const message of info.messages) {
      const ln = message.lineNum ?? "?";
      console.warn(`${message.message}\n  at ${file} line ${ln}`);
    }
    throw new Error(`Could not compile ${file}`);
  }
  return module;
}

export const sizes = {
  f32: 4,
  u32: 4,
  i32: 4,
  vec2: 8,
  vec4: 16,
} as const;