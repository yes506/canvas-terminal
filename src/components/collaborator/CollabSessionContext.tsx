import { createContext, useContext } from "react";

export const CollabSessionContext = createContext<string | null>(null);

export function useCollabSessionId(): string {
  const id = useContext(CollabSessionContext);
  if (!id) throw new Error("useCollabSessionId must be used within CollabSessionContext.Provider");
  return id;
}
