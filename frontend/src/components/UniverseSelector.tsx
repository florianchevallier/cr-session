import type { PlayerInfo } from "../lib/api";
import Notice from "./ui/Notice";
import {
  AddUniversePanel,
  RenameUniversePanel,
} from "./universe/UniverseManagementPanels";
import { UniverseContextSection } from "./universe/UniverseContextSection";
import { UniversePickerSection } from "./universe/UniversePickerSection";
import { useUniverseSelectorController } from "./universe/useUniverseSelectorController";

const EMPTY_PLAYERS: PlayerInfo[] = [];
const UNIVERSE_SELECT_ID = "universe-select";
const UNIVERSE_CONTEXT_ID = "universe-context";
const SESSION_HISTORY_ID = "universe-session-history";

interface UniverseSelectorProps {
  selectedUniverse: string;
  universeContext: string;
  sessionHistory: string;
  players?: PlayerInfo[];
  onUniverseChange: (id: string) => void;
  onContextChange: (context: string) => void;
  onSessionHistoryChange: (history: string) => void;
  onDefaultPlayersChange?: (players: PlayerInfo[]) => void;
}

export default function UniverseSelector({
  selectedUniverse,
  universeContext,
  sessionHistory,
  players = EMPTY_PLAYERS,
  onUniverseChange,
  onContextChange,
  onSessionHistoryChange,
  onDefaultPlayersChange,
}: UniverseSelectorProps) {
  const {
    universes,
    ui,
    currentUniverse,
    canManageCurrentUniverse,
    handleUniverseChange,
    handleContextChange,
    handleSessionHistoryChange,
    handleSaveDefaultPlayers,
    handleCreateUniverse,
    handleRenameUniverse,
    handleDeleteUniverse,
    copyUniversePrompt,
    openAddPanel,
    openRenamePanel,
    closeActivePanel,
    toggleExpanded,
    refreshUniverses,
  } = useUniverseSelectorController({
    selectedUniverse,
    universeContext,
    sessionHistory,
    players,
    onUniverseChange,
    onContextChange,
    onSessionHistoryChange,
    onDefaultPlayersChange,
  });

  return (
    <div className="space-y-4">
      <UniversePickerSection
        selectedUniverse={selectedUniverse}
        universes={universes}
        canManageCurrentUniverse={canManageCurrentUniverse}
        isDeletingUniverse={ui.isDeletingUniverse}
        isLoadingUniverses={ui.isLoadingUniverses}
        selectId={UNIVERSE_SELECT_ID}
        onUniverseChange={(id) => void handleUniverseChange(id)}
        onAddUniverse={openAddPanel}
        onRenameUniverse={openRenamePanel}
        onDeleteUniverse={() => void handleDeleteUniverse()}
        onRefreshUniverses={() => void refreshUniverses()}
      />

      {ui.activePanel === "add" && (
        <AddUniversePanel
          onCreate={handleCreateUniverse}
          onCancel={closeActivePanel}
        />
      )}

      {ui.activePanel === "rename" && currentUniverse && currentUniverse.isCustom && (
        <RenameUniversePanel
          initialLabel={currentUniverse.label}
          onRename={handleRenameUniverse}
          onCancel={closeActivePanel}
        />
      )}

      {ui.managementError && <Notice tone="danger">{ui.managementError}</Notice>}

      <UniverseContextSection
        isExpanded={ui.isExpanded}
        promptCopied={ui.promptCopied}
        universeContext={universeContext}
        sessionHistory={sessionHistory}
        contextInputId={UNIVERSE_CONTEXT_ID}
        historyInputId={SESSION_HISTORY_ID}
        onToggleExpanded={toggleExpanded}
        onCopyPrompt={() => void copyUniversePrompt()}
        onContextChange={handleContextChange}
        onSessionHistoryChange={handleSessionHistoryChange}
        onSaveDefaultPlayers={handleSaveDefaultPlayers}
      />
    </div>
  );
}
