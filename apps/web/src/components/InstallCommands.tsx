import { T } from "gt-react";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

export function InstallCommands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        <T>
          This fork runs from source: start the server from the repository checkout. If{" "}
          <code className="font-mono">t3</code> is not on your PATH, run the command from{" "}
          <code className="font-mono">apps/server</code>.
        </T>
      </p>
    </div>
  );
}
