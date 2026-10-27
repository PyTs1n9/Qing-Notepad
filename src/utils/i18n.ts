import type { LangType } from "@/stores/settingsStore";

export type TranslationKeys = {
  todo: string;
  notepad: string;
  imageHost: string;
  canvas: string;
  canvasSelect: string;
  canvasPan: string;
  canvasInsert: string;
  canvasDraw: string;
  canvasArrange: string;
  canvasView: string;
  canvasStyle: string;
  canvasAddImage: string;
  canvasAddText: string;
  canvasDoodlePen: string;
  canvasDoodleEraser: string;
  canvasDoodleColor: string;
  canvasDoodleWidth: string;
  canvasEraserShape: string;
  canvasEraserCircle: string;
  canvasEraserSquare: string;
  canvasEraserSize: string;
  canvasEraserOpacity: string;
  canvasClearDoodles: string;
  canvasZoomOut: string;
  canvasZoomIn: string;
  canvasResetZoom: string;
  canvasFit: string;
  canvasMoveLayerUp: string;
  canvasMoveLayerDown: string;
  canvasDelete: string;
  canvasExport: string;
  canvasExporting: string;
  canvasSaved: string;
  canvasSaving: string;
  canvasEmpty: string;
  canvasPasteHint: string;
  canvasLoading: string;
  canvasGuideTitle: string;
  canvasGuideSelect: string;
  canvasGuidePan: string;
  canvasGuideAdd: string;
  canvasGuideZoom: string;
  canvasGuideEdit: string;
  canvasGuideOverview: string;
  canvasOverview: string;
  canvasNew: string;
  canvasNamePlaceholder: string;
  canvasRename: string;
  canvasDeleteQuestion: string;
  canvasDeleteCanvas: string;
  canvasOpenList: string;
  canvasCloseList: string;
  canvasNodeText: string;
  canvasShapeRectangle: string;
  canvasShapeRounded: string;
  canvasShapeEllipse: string;
  canvasShapeDiamond: string;
  canvasConnectorStraight: string;
  canvasConnectorOrthogonal: string;
  canvasDuplicate: string;
  canvasAlignHorizontal: string;
  canvasAlignVertical: string;
  canvasShapeFill: string;
  canvasShapeStroke: string;
  canvasFill: string;
  canvasStroke: string;
  canvasTextStyle: string;
  canvasParagraph: string;
  canvasFontSize: string;
  canvasFontFamily: string;
  canvasDefaultFont: string;
  canvasBold: string;
  canvasItalic: string;
  canvasUnderline: string;
  canvasStrike: string;
  canvasHighlight: string;
  canvasTextColor: string;
  canvasBulletList: string;
  canvasOrderedList: string;
  canvasQuote: string;
  canvasAlignLeft: string;
  canvasAlignCenter: string;
  canvasAlignRight: string;
  canvasDone: string;
  canvasOpenTile: string;
  canvasTile: string;
  canvasTileLoading: string;
  canvasPinTile: string;
  canvasUnpinTile: string;
  explorer: string;
  newNote: string;
  importMd: string;
  importTxt: string;
  importNote: string;
  comingSoon: string;
  notes: string;
  categories: string;
  allNotes: string;
  uncategorizedNotes: string;
  newCategory: string;
  renameCategory: string;
  deleteCategory: string;
  newSubfolder: string;
  unnamedFolder: string;
  renameNote: string;
  moveToFolder: string;
  pinCategory: string;
  unpinCategory: string;
  confirmDeleteCategory: string;
  dragCategory: string;
  resizeCategoryPanel: string;
  resizeCategoryPanelHint: string;
  dragNote: string;
  expandFolder: string;
  collapseFolder: string;
  moveNoteToCategoryConfirm: string;
  tags: string;
  all: string;
  settings: string;
  authSignIn: string;
  authSignUp: string;
  authSignOut: string;
  authAccount: string;
  authWelcome: string;
  authSubtitle: string;
  authSignedIn: string;
  authEmail: string;
  authPassword: string;
  authConfirmPassword: string;
  authShowPassword: string;
  authHidePassword: string;
  authPasswordPlaceholder: string;
  authPasswordTooShort: string;
  authPasswordMismatch: string;
  authCheckEmail: string;
  authWorking: string;
  authAutoSigningIn: string;
  authRememberPassword: string;
  authAutoLogin: string;
  authForgotPassword: string;
  authForgotPasswordTitle: string;
  authForgotPasswordHint: string;
  authSendResetEmail: string;
  authResendResetEmail: string;
  authChangeResetEmail: string;
  authResetEmailRequired: string;
  authResetEmailSent: string;
  authManualRecoveryHint: string;
  authRecoveryLinkPlaceholder: string;
  authVerifyRecoveryLink: string;
  authRecoveryLinkRequired: string;
  authResetPasswordTitle: string;
  authResetPasswordHint: string;
  authNewPassword: string;
  authSetNewPassword: string;
  authRecoveryLinkInvalid: string;
  authPasswordResetSuccess: string;
  authPasswordResetDone: string;
  authNotConfigured: string;
  authNotConfiguredHint: string;
  workspace: string;
  workspaceTitle: string;
  workspaceOverview: string;
  overviewDocuments: string;
  overviewMembers: string;
  overviewRecent: string;
  overviewRecentEmpty: string;
  overviewRecentEmptyHint: string;
  overviewOwnerTools: string;
  overviewInviteCode: string;
  overviewCopyInvite: string;
  overviewCopied: string;
  overviewPendingPublish: string;
  overviewBackToOverview: string;
  overviewNoWorkspaceTitle: string;
  overviewNoWorkspaceHint: string;
  overviewReadOnlyHint: string;
  overviewUpdatedAt: string;
  workspaceLoginRequired: string;
  workspaceLoginHint: string;
  createWorkspace: string;
  joinWorkspace: string;
  workspaceAlreadyJoined: string;
  workspaceName: string;
  workspaceNameHint: string;
  renameWorkspace: string;
  saveWorkspaceName: string;
  inviteCode: string;
  inviteRole: string;
  manageWorkspace: string;
  permissionManagement: string;
  permissionManagementHint: string;
  workspaceSettings: string;
  shareWorkspace: string;
  copyInvite: string;
  copied: string;
  regenerateInvite: string;
  newCloudDocument: string;
  newCloudDocumentHint: string;
  renameCloudDocument: string;
  documentActions: string;
  dragCloudDocument: string;
  documentDetails: string;
  deleteCloudDocument: string;
  cloudDocumentName: string;
  documentCreator: string;
  publicationStatus: string;
  collaborationMode: string;
  realTimeCollaboration: string;
  publishedAt: string;
  cloudDocumentDraft: string;
  cloudDocumentUnpublished: string;
  cloudDocumentScheduled: string;
  cloudDocumentPublished: string;
  manageCloudDocumentPublication: string;
  publishCloudDocumentNow: string;
  scheduleCloudDocument: string;
  rescheduleCloudDocument: string;
  cancelScheduledPublish: string;
  scheduledPublishTime: string;
  scheduledPublishHour: string;
  scheduledPublishMinute: string;
  previousMonth: string;
  nextMonth: string;
  scheduledPublishFuture: string;
  cloudDocumentPublishUnsynced: string;
  cloudDocumentPublicationHint: string;
  cloudDocumentPublishedHint: string;
  unpublishCloudDocument: string;
  cloudDocumentUnpublishWarning: string;
  confirmUnpublishCloudDocument: string;
  keepCloudDocumentPublished: string;
  documentPermissions: string;
  documentPermissionsHint: string;
  documentAccessLevel: string;
  accessCreator: string;
  accessManagers: string;
  accessMembers: string;
  accessCreatorHint: string;
  accessManagersHint: string;
  accessMembersHint: string;
  transferCreator: string;
  confirmTransferCreator: string;
  transferCreatorWarning: string;
  memberPermissions: string;
  memberPermissionsHint: string;
  currentUser: string;
  workspaceDocuments: string;
  noWorkspaces: string;
  noCloudDocuments: string;
  noFilteredCloudDocuments: string;
  noCloudDocumentsReadOnly: string;
  workspaceMembers: string;
  roleOwner: string;
  roleEditor: string;
  roleViewer: string;
  removeMember: string;
  confirmRemoveMember: string;
  removedFromWorkspaceTitle: string;
  removedFromWorkspaceMessage: string;
  acknowledge: string;
  leaveWorkspace: string;
  deleteWorkspace: string;
  confirmDeleteWorkspace: string;
  confirmDeleteCloudDocument: string;
  collaborationConnecting: string;
  collaborationConnected: string;
  collaborationDisconnected: string;
  collaborationError: string;
  collaborationNotConfigured: string;
  collaborationNetworkGood: string;
  collaborationNetworkFair: string;
  collaborationNetworkSlow: string;
  collaborationNetworkUnstable: string;
  collaborationNetworkHistory: string;
  collaborationNetworkCurrent: string;
  collaborationNetworkMinimum: string;
  collaborationNetworkMaximum: string;
  collaborationNetworkSlowest: string;
  collaborationNetworkAverage: string;
  collaborationNetworkP95: string;
  collaborationSyncBacklog: string;
  collaborationNetworkThresholds: string;
  collaborationNetworkWaiting: string;
  collaborationLocalProtection: string;
  collaborationSyncPending: string;
  collaborationLocalFallback: string;
  onlineUsers: string;
  userHighlights: string;
  synchronizedScroll: string;
  independentScroll: string;
  readOnly: string;
  cloudSavedRealtime: string;
  workspaceBackendNotReady: string;
  noNotes: string;
  untitled: string;
  noteTabs: string;
  closeTab: string;
  closeOtherTabs: string;
  closeTabsToRight: string;
  closeAllTabs: string;
  pinTab: string;
  previewTabHint: string;
  scrollTabsLeft: string;
  scrollTabsRight: string;
  confirmDelete: string;
  confirmDeleteNoteMessage: string;
  confirmYes: string;
  confirmNo: string;
  deleteNote: string;
  deleteTodo: string;
  confirmDeleteTodoMessage: string;
  todoLists: string;
  newTodoList: string;
  newTodo: string;
  defaultTodoList: string;
  listNamePlaceholder: string;
  renameTodoList: string;
  deleteTodoList: string;
  confirmDeleteTodoListMessage: string;
  pinTodoList: string;
  unpinTodoList: string;
  dragTodoList: string;
  todoTitle: string;
  totalStats: string;
  priorityFilter: string;
  addTaskPlaceholder: string;
  lowPriority: string;
  mediumPriority: string;
  highPriority: string;
  dueDate: string;
  noDueDate: string;
  clearDueDate: string;
  add: string;
  filterAll: string;
  filterActive: string;
  filterCompleted: string;
  filterPriority: string;
  noCompleted: string;
  allDone: string;
  noTodos: string;
  noTodosHint: string;
  searchNoResults: string;
  searchNoResultsHint: string;
  pinTodo: string;
  unpinTodo: string;
  subtask: string;
  addSubtask: string;
  expandSubtasks: string;
  collapseSubtasks: string;
  expandList: string;
  collapseList: string;
  newTaskInList: string;
  deleteSubtask: string;
  confirmDeleteTodoWithSubtasks: string;
  todoDescription: string;
  addTodoDescription: string;
  editTodoDescription: string;
  todoDescriptionPlaceholder: string;
  low: string;
  medium: string;
  high: string;
  noteTitlePlaceholder: string;
  createdAt: string;
  updatedAt: string;
  selectNote: string;
  orCreateNote: string;
  sourceEditor: string;
  preview: string;
  mdViewSource: string;
  mdViewPreview: string;
  mdViewSplit: string;
  mdPlaceholder: string;
  inputTagName: string;
  toggleToolbar: string;
  settingsTitle: string;
  settingsBasic: string;
  settingsTheme: string;
  settingsStorage: string;
  storageCurrent: string;
  storageBadgeDefault: string;
  storageBadgeCustom: string;
  storageUsage: string;
  storageChangeDir: string;
  storageRestoreDefault: string;
  storageUnavailable: string;
  storageMigrateTitle: string;
  storageMigrateBody: string;
  storageMigrating: string;
  storageMigratingStart: string;
  storageMigrateDone: string;
  storageMigrateFailed: string;
  storageRestoreMigrateBody: string;
  storageAdoptBody: string;
  storageNotALibrary: string;
  storageReloading: string;
  dialogConfirm: string;
  dialogCancel: string;
  themeColor: string;
  darkTheme: string;
  blueTheme: string;
  yellowTheme: string;
  greenTheme: string;
  customTheme: string;
  customPalette: string;
  customBackground: string;
  customBackgroundHint: string;
  backgroundHistory: string;
  chooseBackground: string;
  replaceBackground: string;
  removeBackground: string;
  backgroundUploadFailed: string;
  glassGroup: string;
  glassGroupHint: string;
  glassEnable: string;
  glassBaseGroup: string;
  glassBgGroup: string;
  glassBlur: string;
  glassTint: string;
  glassSaturate: string;
  glassNeedsBackground: string;
  glassBlurNeedsLowerTint: string;
  glassBaseOverridden: string;
  glassReducedTransparency: string;
  savePreset: string;
  selectPreset: string;
  noPresets: string;
  deletePreset: string;
  presetName: string;
  presetFull: string;
  bgPrimary: string;
  bgSecondary: string;
  bgSidebar: string;
  textPrimary: string;
  accentColor: string;
  language: string;
  chinese: string;
  english: string;
  personal: string;
  personalSignInTitle: string;
  personalSignInHint: string;
  personalOpenSignIn: string;
  personalSignedIn: string;
  personalProfile: string;
  personalNickname: string;
  personalNicknamePlaceholder: string;
  personalChangeNickname: string;
  personalSaveNickname: string;
  personalChangeAvatar: string;
  personalAvatarHint: string;
  avatarCropTitle: string;
  avatarCropHint: string;
  avatarCropDragHint: string;
  avatarCropZoom: string;
  avatarCropZoomIn: string;
  avatarCropZoomOut: string;
  avatarCropCancel: string;
  avatarCropConfirm: string;
  avatarCropLoadFailed: string;
  avatarHistory: string;
  useHistoryAvatar: string;
  useHistoryBackground: string;
  deleteHistoryImage: string;
  personalSecurity: string;
  personalChangePassword: string;
  personalNewPassword: string;
  personalConfirmPassword: string;
  personalPasswordUpdated: string;
  personalPasswordMismatch: string;
  personalProfileUpdated: string;
  personalAvatarUpdated: string;
  personalSignOutHint: string;
  personalDataHint: string;
  personalNotConfigured: string;
  personalSaving: string;
  personalChooseImage: string;
  close: string;
  defaultFont: string;
  importFont: string;
  exportFile: string;
  exportFilterMarkdown: string;
  exportFilterText: string;
  exportFilterWord: string;
  exportFilterPdf: string;
  exportImagesDropped: string;
  exportFailed: string;
  collapseSidebar: string;
  expandSidebar: string;
  enableAlwaysOnTop: string;
  disableAlwaysOnTop: string;
  saved: string;
  unsaved: string;
  save: string;
  undo: string;
  redo: string;
  insertTable: string;
  insertImage: string;
  insertImageFailed: string;
  about: string;
  aboutTitle: string;
  version: string;
  author: string;
  sourceCode: string;
  personalBlog: string;
  qqDiscussionGroup: string;
  copyQqGroupNumber: string;
  friendSponsor: string;
  minimize: string;
  maximize: string;
  restore: string;
  wordCount: string;
  showWindow: string;
  quitApp: string;
  hideToTray: string;
  shortcutsSection: string;
  autoSaveSection: string;
  autoSaveOff: string;
  autoSave10s: string;
  autoSave30s: string;
  autoSave1m: string;
  stickyOpacity: string;
  dataLocation: string;
  openDataFolder: string;
  imageCache: string;
  openImageCache: string;
  trash: string;
  trashRetention: string;
  trashRetentionDisabled: string;
  trashRetention7Days: string;
  trashRetention30Days: string;
  trashRetention90Days: string;
  trashRetentionForever: string;
  trashHint: string;
  trashEmpty: string;
  trashEmptyHint: string;
  trashRestore: string;
  trashDeleteForever: string;
  trashDeletedAt: string;
  trashOriginalCategory: string;
  trashRemaining: string;
  trashRemainingLessThanDay: string;
  trashExpiresNever: string;
  trashRestored: string;
  trashRestoreMissingImages: string;
  trashRestoreFailed: string;
  trashConfirmDeleteMessage: string;
  trashClearAll: string;
  trashConfirmClearMessage: string;
  trashDisabled: string;
  trashDisabledHint: string;
  trashOpenSettings: string;
  trashLoading: string;
  moveNoteToTrash: string;
  confirmMoveToTrashMessage: string;
  shortcutToggleWindow: string;
  shortcutPinSticky: string;
  resetShortcuts: string;
  pressShortcut: string;
  pinSticky: string;
  unpinSticky: string;
  stickyNote: string;
  stickyEmptyHint: string;
  pinNote: string;
  unpinNote: string;
  tileNoNote: string;
  checkUpdate: string;
  checkingUpdate: string;
  upToDate: string;
  newVersion: string;
  downloadUpdate: string;
  checkUpdateFailed: string;
  updateAvailableTitle: string;
  updateAvailableMessage: string;
  currentVersion: string;
  latestVersion: string;
  updateNow: string;
  updateLater: string;
  neverRemind: string;
  aiAssistant: string;
  aiSettings: string;
  aiApiKey: string;
  aiApiKeyPlaceholder: string;
  aiApiKeyHint: string;
  aiSaveKey: string;
  aiClearKey: string;
  aiVerifyKey: string;
  aiKeySaved: string;
  aiKeyCleared: string;
  aiKeyMissing: string;
  aiVerifySuccess: string;
  aiPrivacyNoticeTitle: string;
  aiPrivacyNoticeBody: string;
  aiPrivacyAgree: string;
  aiErrorUnauthorized: string;
  aiErrorBalance: string;
  aiErrorRateLimit: string;
  aiErrorNetwork: string;
  aiErrorServer: string;
  aiErrorBadResponse: string;
  aiErrorMissingKey: string;
  aiErrorAborted: string;
  aiSidebarHint: string;
  aiInputPlaceholder: string;
  aiSend: string;
  aiStop: string;
  aiClearChat: string;
  aiThinking: string;
  aiPhaseRetrieving: string;
  aiPhaseWriting: string;
  aiTruncated: string;
  aiViewDiff: string;
  aiDiffTooLong: string;
  aiDiffUnavailable: string;
  aiReasoning: string;
  aiNoResult: string;
  aiNoKeyHint: string;
  aiModelLabel: string;
  aiModelLocal: string;
  aiModelLocalSub: string;
  aiModelSection: string;
  aiModelAdd: string;
  aiModelNoEndpoint: string;
  aiThinkingTitle: string;
  aiThinkingOff: string;
  aiThinkingLow: string;
  aiThinkingHigh: string;
  aiThinkingEffectOff: string;
  aiThinkingEffectLow: string;
  aiThinkingEffectHigh: string;
  aiEndpointTitle: string;
  aiEndpointHint: string;
  aiEndpointEmpty: string;
  aiEndpointUntitled: string;
  aiEndpointNoUrl: string;
  aiEndpointModelCount: string;
  aiEndpointName: string;
  aiEndpointNamePlaceholder: string;
  aiEndpointBaseUrl: string;
  aiEndpointKey: string;
  aiEndpointKeySet: string;
  aiEndpointKeyPlaceholder: string;
  aiEndpointModels: string;
  aiEndpointSearch: string;
  aiEndpointSearching: string;
  aiEndpointNoModels: string;
  aiEndpointThinkingHint: string;
  aiEndpointModelsHint: string;
  aiEndpointDelete: string;
  aiEndpointDeleteConfirm: string;
  /** Warns how many chat sessions go with the endpoint being deleted. */
  aiEndpointDeleteSessions: string;
  aiEndpointCancel: string;
  aiEndpointAdd: string;
  aiEndpointCustom: string;
  aiActPolish: string;
  aiActRewrite: string;
  aiActContinue: string;
  aiActSummarize: string;
  aiActTranslate: string;
  aiActChecklist: string;
  aiActCardHint: string;
  aiCardTitle: string;
  aiCardCopy: string;
  aiCardCopied: string;
  aiCardPoints: string;
  aiCardTags: string;
  aiSmallTalkGreeting: string;
  aiSmallTalkIdentity: string;
  panelCrashTitle: string;
  panelCrashBody: string;
  panelCrashRetry: string;
  aiPolishModelLabel: string;
  aiAnswerSteps: string;
  aiAnswerHowto: string;
  aiAnswerWhere: string;
  aiAnswerWhereAlt: string;
  aiAnswerVerdict: string;
  aiAnswerExplain: string;
  aiAnswerExcerpt: string;
  aiExampleQ1: string;
  aiExampleQ2: string;
  aiExampleQ3: string;
  aiExampleQ4: string;
  aiExampleQ5: string;
  aiExampleQ6: string;
  aiExampleQ7: string;
  aiExampleQ8: string;
  aiExampleQ9: string;
  aiExampleQ10: string;
  aiExampleQ11: string;
  aiExampleQ12: string;
  aiShuffleExamples: string;
  aiClose: string;
  aiCopy: string;
  aiCopied: string;
  aiRegenerate: string;
  aiDeleteMessage: string;
  aiClearConfirmTitle: string;
  aiClearConfirmBody: string;
  aiClearConfirmOk: string;
  aiCancel: string;
  aiGreeting: string;
  aiEmptyGreetingApi: string;
  /** Degenerate case: the channel works out to the same name as the model. */
  aiEmptyGreetingModel: string;
  aiEmptyGreetingNoKey: string;
  aiStatusReady: string;
  aiStatusNoKey: string;
  aiNewChat: string;
  aiHistory: string;
  aiRename: string;
  aiDeleteConversation: string;
  aiDeleteConversationTitle: string;
  aiDeleteConversationBody: string;
  aiNoConversations: string;
  aiUntitled: string;
  aiPolishTitle: string;
  aiPolishEntry: string;
  aiPolishNoSelection: string;
  aiPolishPlaceholder: string;
  aiPolishGenerate: string;
  aiPolishApply: string;
  aiPolishUndo: string;
  aiPolishApplied: string;
  aiPolishBack: string;
  aiPolishStylePolish: string;
  aiPolishStyleConcise: string;
  aiPolishStyleFormal: string;
  aiPolishStyleCasual: string;
  aiDiffBefore: string;
  aiDiffAfter: string;
  aiPolishStale: string;
  aiPermLabel: string;
  aiPermReadOnly: string;
  aiPermFull: string;
  aiPermLocalOnly: string;
  aiPermConfirmTitle: string;
  aiPermConfirmBody: string;
  aiPermConfirmOk: string;
  aiEditApplied: string;
  aiUndoEdit: string;
  aiEditUndone: string;
  // Help entry: the only dropdown left in the title bar.
  helpMenu: string;
  helpManual: string;
  helpFaq: string;
  helpShortcuts: string;
  helpReportIssue: string;
  helpShortcutsNote: string;
  shortcutGroupGlobal: string;
  shortcutGroupNote: string;
  shortcutGroupTabs: string;
  shortcutGroupCanvas: string;
  shortcutSaveNote: string;
  shortcutCloseTab: string;
  shortcutInsertTable: string;
  shortcutUndoRedo: string;
  retry: string;
  quitConfirmTitle: string;
  quitConfirmMessage: string;
  updateCheckErrorDetail: string;
  importFailed: string;
  loading: string;
  authSignedOut: string;

  // --- Plugins (L1) ---
  pluginsTitle: string;
  pluginsSearchPlaceholder: string;
  pluginsInstalledSection: string;
  pluginsAvailableSection: string;
  pluginsEmptyInstalled: string;
  pluginsEmptyAvailable: string;
  pluginsOfflineHint: string;
  pluginsIndexLoading: string;
  pluginsInstallFromFile: string;
  pluginsInstallFromFolder: string;
  pluginsRefreshIndex: string;
  pluginsOnline: string;
  pluginsOffline: string;
  pluginsSelectHint: string;
  pluginsSelectHintBody: string;
  pluginsSidebarFooterHint: string;
  pluginVersion: string;
  pluginAuthor: string;
  pluginRepository: string;
  pluginLicense: string;
  pluginPermissions: string;
  pluginPermissionsNone: string;
  pluginCommands: string;
  pluginNoCommands: string;
  pluginInstall: string;
  pluginUpdate: string;
  pluginUninstall: string;
  pluginUninstallTitle: string;
  pluginUninstallBody: string;
  pluginUninstallKeep: string;
  pluginUninstallDrop: string;
  pluginRollback: string;
  pluginEnable: string;
  pluginDisable: string;
  pluginEnabled: string;
  pluginDisabled: string;
  pluginRunning: string;
  pluginNotRunning: string;
  pluginSourceIndex: string;
  pluginSource: string;
  pluginInfo: string;
  pluginSourceFile: string;
  pluginViewLog: string;
  pluginLogEmpty: string;
  pluginLogTitle: string;
  pluginUpdateAvailable: string;
  pluginPermissionRevoke: string;
  pluginPermissionNew: string;
  pluginPermissionGrant: string;
  pluginLockedNote: string;
  pluginPermPromptInstallTitle: string;
  pluginPermPromptUpdateTitle: string;
  pluginPermPromptBody: string;
  pluginPermPromptAddedBody: string;
  pluginPermPromptApprove: string;
  pluginPermPromptUpdate: string;
  pluginPermPromptCancel: string;
  pluginPermStorage: string;
  pluginPermNotesRead: string;
  pluginPermNotesWrite: string;
  pluginPermTodoRead: string;
  pluginPermTodoWrite: string;
  pluginPermClipboardRead: string;
  pluginPermClipboardWrite: string;
  pluginPermNotify: string;
  pluginPermEditorRead: string;
  pluginPermEditorWrite: string;
  pluginPermEditorDecorate: string;
  pluginPermViews: string;
  pluginPermEditorSelection: string;
  pluginCrashedDisabled: string;
  pluginPermissionDenied: string;
  pluginInstalled: string;
  pluginUpdated: string;
  pluginUninstalled: string;
  pluginRolledBack: string;
  pluginCommandFailed: string;
  pluginInstallFailed: string;
  pluginHostIncompatible: string;
  pluginApiIncompatible: string;
  pluginCommandConflict: string;
  pluginNativeModule: string;
  pluginPackageTooLarge: string;
  pluginManifestMissing: string;
  pluginManifestInvalid: string;
  pluginMissingMain: string;
  pluginTooManyFiles: string;
  pluginPermissionUnknown: string;
  pluginEntryNameInvalid: string;
  pluginIndexPermissionMismatch: string;
  commandPaletteTitle: string;
  commandPalettePlaceholder: string;
  commandPaletteEmpty: string;
  commandPaletteHint: string;
  commandCategoryView: string;
  commandCategoryNote: string;
  commandCategoryApp: string;
  commandCategoryPlugin: string;
  commandNewNote: string;
  commandOpenSettings: string;
  commandToggleAi: string;
  settingsPlugins: string;
  pluginsSettingsOpen: string;
  pluginsSettingsOpenHint: string;
  pluginsDisableAll: string;
  pluginsDisableAllHint: string;
};

const zh: TranslationKeys = {
  explorer: "资源管理器",
  imageHost: "图床",
  canvas: "画布",
  canvasSelect: "选择",
  canvasPan: "平移",
  canvasInsert: "插入",
  canvasDraw: "绘制",
  canvasArrange: "排列",
  canvasView: "视图",
  canvasStyle: "样式",
  canvasAddImage: "添加图片",
  canvasAddText: "添加文字",
  canvasDoodlePen: "涂鸦笔",
  canvasDoodleEraser: "涂鸦橡皮擦",
  canvasDoodleColor: "画笔颜色",
  canvasDoodleWidth: "画笔粗细",
  canvasEraserShape: "橡皮擦形状",
  canvasEraserCircle: "圆形",
  canvasEraserSquare: "方形",
  canvasEraserSize: "橡皮擦大小",
  canvasEraserOpacity: "橡皮擦透明度",
  canvasClearDoodles: "清空本页涂鸦",
  canvasZoomOut: "缩小",
  canvasZoomIn: "放大",
  canvasResetZoom: "重置缩放",
  canvasFit: "适应画布",
  canvasMoveLayerUp: "上移图层",
  canvasMoveLayerDown: "下移图层",
  canvasDelete: "删除对象",
  canvasExport: "导出",
  canvasExporting: "导出中…",
  canvasSaved: "已保存",
  canvasSaving: "保存中…",
  canvasEmpty: "画布还是空的",
  canvasPasteHint: "粘贴截图、拖入图片，或用工具栏添加文字与结构节点",
  canvasLoading: "正在加载画布…",
  canvasGuideTitle: "画布使用说明",
  canvasGuideSelect: "选择：拖动对象，Shift 多选；拖拽右下角调整大小",
  canvasGuidePan: "平移：选择“平移”工具，或按住空格拖动",
  canvasGuideAdd: "添加：插入图片、文字或结构节点；连接工具依次点击两个节点",
  canvasGuideZoom: "缩放：按住 Ctrl/Cmd + 滚轮缩放画布；选中图片调整图片大小，选中文字调整字号",
  canvasGuideEdit: "编辑：双击文字或节点打开富文本工具栏；选中对象后可用 Ctrl/Cmd+X、C、V 剪切、复制和粘贴",
  canvasGuideOverview: "小地图：右下角查看所有对象位置与当前视口，点击对象可居中跟踪",
  canvasOverview: "画布总览",
  canvasNew: "新建画布",
  canvasNamePlaceholder: "输入画布名称",
  canvasRename: "重命名画布",
  canvasDeleteQuestion: "确定删除“{name}”吗？",
  canvasDeleteCanvas: "删除画布",
  canvasOpenList: "展开画布列表",
  canvasCloseList: "收起画布列表",
  canvasNodeText: "节点",
  canvasShapeRectangle: "矩形节点",
  canvasShapeRounded: "圆角节点",
  canvasShapeEllipse: "椭圆节点",
  canvasShapeDiamond: "判断节点",
  canvasConnectorStraight: "直线箭头",
  canvasConnectorOrthogonal: "折线箭头",
  canvasDuplicate: "复制所选对象",
  canvasAlignHorizontal: "水平居中对齐",
  canvasAlignVertical: "垂直居中对齐",
  canvasShapeFill: "节点填充色",
  canvasShapeStroke: "边框或连线颜色",
  canvasFill: "填充",
  canvasStroke: "描边",
  canvasTextStyle: "文字样式",
  canvasParagraph: "正文",
  canvasFontSize: "字号",
  canvasFontFamily: "字体",
  canvasDefaultFont: "默认字体",
  canvasBold: "粗体",
  canvasItalic: "斜体",
  canvasUnderline: "下划线",
  canvasStrike: "删除线",
  canvasHighlight: "高亮",
  canvasTextColor: "文字颜色",
  canvasBulletList: "无序列表",
  canvasOrderedList: "有序列表",
  canvasQuote: "引用",
  canvasAlignLeft: "左对齐",
  canvasAlignCenter: "居中对齐",
  canvasAlignRight: "右对齐",
  canvasDone: "完成",
  canvasOpenTile: "创建画布磁贴",
  canvasTile: "画布磁贴",
  canvasTileLoading: "正在加载画布磁贴…",
  canvasPinTile: "置顶磁贴",
  canvasUnpinTile: "取消置顶",
  todo: "待办事项",
  notepad: "记事本",
  newNote: "新建笔记",
  importMd: "导入 Markdown",
  importTxt: "导入 Text",
  importNote: "导入文件",
  comingSoon: "敬请期待",
  notes: "笔记",
  categories: "分类",
  allNotes: "全部笔记",
  uncategorizedNotes: "未分类笔记",
  newCategory: "新建分类",
  renameCategory: "重命名分类",
  deleteCategory: "删除分类",
  newSubfolder: "新建子文件夹",
  unnamedFolder: "未命名文件夹",
  renameNote: "重命名笔记",
  moveToFolder: "移到文件夹",
  pinCategory: "置顶分类",
  unpinCategory: "取消置顶分类",
  confirmDeleteCategory: '删除分类"',
  dragCategory: "拖动分类",
  resizeCategoryPanel: "调整分类区高度",
  resizeCategoryPanelHint: "拖动调整分类区高度，双击恢复默认",
  dragNote: "拖动笔记",
  expandFolder: "展开文件夹",
  collapseFolder: "折叠文件夹",
  moveNoteToCategoryConfirm: '是否将"{note}"笔记移动到"{category}"文件夹中？',
  tags: "标签",
  all: "全部",
  settings: "设置",
  authSignIn: "登录",
  authSignUp: "注册",
  authSignOut: "退出登录",
  authAccount: "账号",
  authWelcome: "登录 Qing Notepad",
  authSubtitle: "登录后可使用联网工作台",
  authSignedIn: "当前已登录",
  authEmail: "邮箱",
  authPassword: "密码",
  authConfirmPassword: "确认密码",
  authShowPassword: "显示密码",
  authHidePassword: "隐藏密码",
  authPasswordPlaceholder: "至少 6 位密码",
  authPasswordTooShort: "密码至少需要 6 位",
  authPasswordMismatch: "两次输入的密码不一致",
  authCheckEmail: "注册成功，请打开邮箱完成验证后再登录。",
  authWorking: "处理中...",
  authAutoSigningIn: "正在自动登录",
  authRememberPassword: "记住密码",
  authAutoLogin: "自动登录",
  authForgotPassword: "找回密码",
  authForgotPasswordTitle: "找回密码",
  authForgotPasswordHint: "输入注册邮箱，我们会向该邮箱发送密码恢复链接。",
  authSendResetEmail: "发送重置邮件",
  authResendResetEmail: "重新发送",
  authChangeResetEmail: "更换邮箱",
  authResetEmailRequired: "请先输入用于找回密码的邮箱",
  authResetEmailSent: "密码重置邮件已发送，请复制邮件中的重置链接。",
  authManualRecoveryHint: "在邮件中右键复制“重置密码”按钮的链接，粘贴到这里即可继续。",
  authRecoveryLinkPlaceholder: "粘贴完整的密码恢复链接",
  authVerifyRecoveryLink: "验证链接并继续",
  authRecoveryLinkRequired: "请先粘贴邮件中的密码恢复链接",
  authResetPasswordTitle: "设置新密码",
  authResetPasswordHint: "恢复链接已验证，请设置新的登录密码。",
  authNewPassword: "新密码",
  authSetNewPassword: "确认修改密码",
  authRecoveryLinkInvalid: "恢复链接无效或已过期，请重新发送找回密码邮件。",
  authPasswordResetSuccess: "密码修改成功",
  authPasswordResetDone: "完成",
  authNotConfigured: "登录服务尚未配置",
  authNotConfiguredHint: "请在 .env.local 中填写 Supabase Project URL 和 publishable/anon key，然后重新启动应用。",
  workspace: "工作台",
  workspaceTitle: "工作台",
  workspaceOverview: "概览",
  overviewDocuments: "文档",
  overviewMembers: "成员",
  overviewRecent: "最近编辑",
  overviewRecentEmpty: "还没有可显示的编辑记录",
  overviewRecentEmptyHint: "新建一篇云文档，它会出现在这里",
  overviewOwnerTools: "工作台管理",
  overviewInviteCode: "邀请码",
  overviewCopyInvite: "复制邀请码",
  overviewCopied: "已复制",
  overviewPendingPublish: "待发布",
  overviewBackToOverview: "返回概览",
  overviewNoWorkspaceTitle: "还没有工作台",
  overviewNoWorkspaceHint: "创建一个工作台，或用邀请码加入一个",
  overviewReadOnlyHint: "你在当前工作台中是阅读者，可以浏览但不能新建文档",
  overviewUpdatedAt: "最近更新",
  workspaceLoginRequired: "登录后使用工作台",
  workspaceLoginHint: "登录后即可创建或加入多人协作工作台",
  createWorkspace: "创建工作台",
  joinWorkspace: "加入工作台",
  workspaceAlreadyJoined: "已经加入该工作台",
  workspaceName: "工作台名称",
  workspaceNameHint: "仅工作台创建者可以修改名称",
  renameWorkspace: "修改工作台名称",
  saveWorkspaceName: "保存名称",
  inviteCode: "邀请码",
  inviteRole: "新成员权限",
  manageWorkspace: "管理工作台",
  permissionManagement: "权限管理",
  permissionManagementHint: "统一管理成员角色与每篇文档的阅读范围",
  workspaceSettings: "工作台设置",
  shareWorkspace: "分享工作台",
  copyInvite: "复制邀请码",
  copied: "已复制",
  regenerateInvite: "更换邀请码",
  newCloudDocument: "新建云文档",
  newCloudDocumentHint: "创建草稿并在当前工作台协作",
  renameCloudDocument: "修改文档名",
  documentActions: "文档操作",
  dragCloudDocument: "上下拖动云文档",
  documentDetails: "文档详情",
  deleteCloudDocument: "删除文档",
  cloudDocumentName: "文档名称",
  documentCreator: "创建者",
  publicationStatus: "发布状态",
  collaborationMode: "协作模式",
  realTimeCollaboration: "云端实时协作",
  publishedAt: "发布时间",
  cloudDocumentDraft: "草稿",
  cloudDocumentUnpublished: "未发布",
  cloudDocumentScheduled: "定时",
  cloudDocumentPublished: "已发布",
  manageCloudDocumentPublication: "发布设置",
  publishCloudDocumentNow: "立即发布",
  scheduleCloudDocument: "定时发布",
  rescheduleCloudDocument: "修改发布时间",
  cancelScheduledPublish: "取消定时",
  scheduledPublishTime: "发布时间",
  scheduledPublishHour: "小时",
  scheduledPublishMinute: "分钟",
  previousMonth: "上个月",
  nextMonth: "下个月",
  scheduledPublishFuture: "请选择未来的发布时间",
  cloudDocumentPublishUnsynced: "请等待当前修改同步完成后再发布",
  cloudDocumentPublicationHint: "发布后文档将开放给全体成员；也可以在权限管理中直接调整阅读范围。",
  cloudDocumentPublishedHint: "文档当前对全体成员开放。下架后将仅创建者和管理者可见。",
  unpublishCloudDocument: "下架为草稿",
  cloudDocumentUnpublishWarning: "下架后普通用户将立即失去访问权限，已打开文档的普通用户也会被断开。确定继续吗？",
  confirmUnpublishCloudDocument: "确认下架",
  keepCloudDocumentPublished: "暂不下架",
  documentPermissions: "文档阅读权限",
  documentPermissionsHint: "为不同文档设置独立的阅读范围，权限由服务端强制执行。",
  documentAccessLevel: "访问范围",
  accessCreator: "仅创建者",
  accessManagers: "创建者与管理者",
  accessMembers: "全体成员",
  accessCreatorHint: "只有工作台创建者可以查看和编辑",
  accessManagersHint: "创建者与管理者可以查看和编辑",
  accessMembersHint: "普通用户可查看，创建者与管理者可编辑",
  transferCreator: "转让创建者",
  confirmTransferCreator: "确认转让",
  transferCreatorWarning: "将创建者身份转让给“{member}”后，你会变为管理者，且只有新创建者能继续管理成员权限和删除工作台。",
  memberPermissions: "成员权限",
  memberPermissionsHint: "创建者唯一；管理者可维护文档；普通用户按文档权限只读。",
  currentUser: "你",
  workspaceDocuments: "协作文档",
  noWorkspaces: "还没有工作台，创建或加入一个吧",
  noCloudDocuments: "工作台中还没有文档",
  noFilteredCloudDocuments: "当前发布状态下没有文档",
  noCloudDocumentsReadOnly: "你在此工作台中为普通用户，当前没有可阅读的文档",
  workspaceMembers: "工作台成员",
  roleOwner: "创建者",
  roleEditor: "管理者",
  roleViewer: "普通用户",
  removeMember: "移除成员",
  confirmRemoveMember: '确定将“{member}”移出“{workspace}”工作台吗？移除后，该成员将无法再访问其中的文档。',
  removedFromWorkspaceTitle: "已被移出工作台",
  removedFromWorkspaceMessage: '你已被移出“{workspace}”工作台，无法再访问其中的文档。',
  acknowledge: "知道了",
  leaveWorkspace: "退出工作台",
  deleteWorkspace: "删除工作台",
  confirmDeleteWorkspace: '是否删除"{workspace}"工作台及其中的所有文档？',
  confirmDeleteCloudDocument: '是否删除"{document}"云文档？',
  collaborationConnecting: "正在连接",
  collaborationConnected: "实时同步",
  collaborationDisconnected: "离线编辑",
  collaborationError: "协作连接失败",
  collaborationNotConfigured: "尚未配置协作服务器地址",
  collaborationNetworkGood: "网络良好",
  collaborationNetworkFair: "网络一般",
  collaborationNetworkSlow: "网络较慢",
  collaborationNetworkUnstable: "网络不稳定",
  collaborationNetworkHistory: "网络历史波动",
  collaborationNetworkCurrent: "当前",
  collaborationNetworkMinimum: "最低",
  collaborationNetworkMaximum: "最高",
  collaborationNetworkSlowest: "最慢",
  collaborationNetworkAverage: "平均",
  collaborationNetworkP95: "P95",
  collaborationSyncBacklog: "同步积压",
  collaborationNetworkThresholds: "检测阈值",
  collaborationNetworkWaiting: "等待采样",
  collaborationLocalProtection: "本地保护",
  collaborationSyncPending: "等待同步",
  collaborationLocalFallback: "修改已安全保存在本机，连接恢复后会自动同步",
  onlineUsers: "在线",
  userHighlights: "用户高光",
  synchronizedScroll: "同步滚动",
  independentScroll: "独立滚动",
  readOnly: "只读",
  cloudSavedRealtime: "修改会实时保存",
  workspaceBackendNotReady: "工作台数据库尚未初始化，请先在 Supabase SQL Editor 中执行项目提供的迁移脚本。",
  noNotes: '暂无笔记，点击"新建笔记"开始',
  untitled: "无标题",
  noteTabs: "笔记标签",
  closeTab: "关闭标签",
  closeOtherTabs: "关闭其他标签",
  closeTabsToRight: "关闭右侧标签",
  closeAllTabs: "关闭全部标签",
  pinTab: "固定标签",
  previewTabHint: "预览标签：双击或编辑后固定",
  scrollTabsLeft: "向左滚动标签",
  scrollTabsRight: "向右滚动标签",
  confirmDelete: '确定删除笔记"',
  confirmDeleteNoteMessage: '是否删除"{note}"笔记？',
  confirmYes: "是",
  confirmNo: "否",
  deleteNote: "删除笔记",
  deleteTodo: "删除待办",
  confirmDeleteTodoMessage: '是否删除"{todo}"待办？',
  todoLists: "待办事项",
  newTodoList: "新建清单",
  newTodo: "新建待办",
  defaultTodoList: "我的清单",
  listNamePlaceholder: "输入清单名称",
  renameTodoList: "重命名清单",
  deleteTodoList: "删除清单",
  confirmDeleteTodoListMessage: '删除清单“{list}”及其中的 {count} 项任务？此操作无法撤销。',
  pinTodoList: "置顶清单",
  unpinTodoList: "取消置顶",
  dragTodoList: "拖动清单",
  todoTitle: "待办事项",
  totalStats: "共 {total} 项，已完成 {done} 项",
  priorityFilter: "优先级",
  addTaskPlaceholder: "添加新任务...",
  lowPriority: "低优先级",
  mediumPriority: "中优先级",
  highPriority: "高优先级",
  dueDate: "截止日期",
  noDueDate: "截止",
  clearDueDate: "清除截止日期",
  add: "添加",
  filterAll: "全部",
  filterActive: "进行中",
  filterCompleted: "已完成",
  filterPriority: "全部优先级",
  noCompleted: "还没有已完成的任务",
  allDone: "所有任务都已完成！",
  noTodos: "暂无待办事项，添加一个吧",
  noTodosHint: "在顶部输入框写下第一件事，按回车即可。",
  searchNoResults: "没有匹配的笔记",
  searchNoResultsHint: "换个关键词试试，或清空搜索框查看全部笔记。",
  pinTodo: "置顶待办",
  unpinTodo: "取消置顶",
  subtask: "子待办",
  addSubtask: "添加子待办",
  expandSubtasks: "展开子待办",
  collapseSubtasks: "收起子待办",
  expandList: "展开清单",
  collapseList: "收起清单",
  newTaskInList: "在此清单新建任务",
  deleteSubtask: "删除子待办",
  confirmDeleteTodoWithSubtasks: '删除"{todo}"及其 {count} 个子待办？',
  todoDescription: "待办描述",
  addTodoDescription: "添加描述",
  editTodoDescription: "编辑描述",
  todoDescriptionPlaceholder: "写下细节、链接或验收标准…",
  low: "低",
  medium: "中",
  high: "高",
  noteTitlePlaceholder: "笔记标题...",
  createdAt: "创建于",
  updatedAt: "更新于",
  selectNote: "选择一个笔记开始编辑",
  orCreateNote: '或点击左侧"新建笔记"按钮',
  sourceEditor: "源码编辑",
  preview: "预览",
  mdViewSource: "源码",
  mdViewPreview: "预览",
  mdViewSplit: "分屏",
  mdPlaceholder: "在此输入 Markdown 源码...",
  inputTagName: "输入标签名称:",
  toggleToolbar: "工具栏",
  settingsTitle: "设置",
  settingsBasic: "基础",
  settingsTheme: "主题",
  settingsStorage: "存储",
  storageCurrent: "数据目录",
  storageBadgeDefault: "默认（安装目录）",
  storageBadgeCustom: "自定义",
  storageUsage: "共 {files} 个文件 · {size}",
  storageChangeDir: "更改目录",
  storageRestoreDefault: "恢复默认目录",
  storageUnavailable: "数据目录不可用（磁盘未连接或被移动？）：{path}",
  storageMigrateTitle: "迁移数据目录",
  storageMigrateBody: "把当前全部笔记、图片与 AI 数据迁移到：\n{path}\n\n目标目录必须为空；迁移完成后应用会重启。",
  storageMigrating: "正在迁移… {files} / {total} 个文件",
  storageMigratingStart: "正在统计并准备迁移…",
  storageMigrateDone: "已迁移 {files} 个文件（{size}），即将重启",
  storageMigrateFailed: "迁移失败：{message}",
  storageRestoreMigrateBody: "将把当前数据目录里的全部内容搬回默认目录：\n{path}\n\n默认目录里自动生成的配置文件会被新版覆盖，其他文件不受影响。完成后应用会重启。",
  storageAdoptBody: "目标目录里已经有一份数据（{files} 个文件），看起来是真的数据目录。\n直接切换过去不会移动或删除任何文件，当前目录的内容会留在原处。",
  storageNotALibrary: "目标目录不是空的，也不像一份 Qing Notepad 数据（没有 notes/ 或 settings.json）。请选一个空目录，或选已有的数据目录。",
  storageReloading: "正在重启…",
  dialogConfirm: "确定",
  dialogCancel: "取消",
  themeColor: "主题颜色",
  darkTheme: "深色",
  blueTheme: "蓝调",
  yellowTheme: "忧郁黄",
  greenTheme: "清新绿",
  customTheme: "自定义",
  customPalette: "自定义调色板",
  customBackground: "自定义背景",
  customBackgroundHint: "支持 JPG、PNG、WebP，图片将铺满主界面并存储在 img-need 中。",
  backgroundHistory: "历史背景",
  chooseBackground: "选择背景",
  replaceBackground: "更换背景",
  removeBackground: "移除背景",
  backgroundUploadFailed: "背景图片上传失败",
  glassGroup: "毛玻璃",
  glassGroupHint: "面板半透明与模糊强度，背景图片会透过面板。",
  glassEnable: "启用毛玻璃",
  glassBaseGroup: "基础（始终生效）",
  glassBgGroup: "仅背景图片时",
  glassBlur: "模糊强度",
  glassTint: "侧栏底色不透明度",
  glassSaturate: "饱和度",
  glassNeedsBackground: "需先设置背景图",
  glassBlurNeedsLowerTint: "底色不透明度低于 60% 时模糊才明显",
  glassBaseOverridden: "已设置背景图，实际生效的是下方一组",
  glassReducedTransparency:
    "系统已关闭「透明效果」，毛玻璃不会生效。请在「Windows 设置 → 个性化 → 颜色」中开启透明效果。",
  savePreset: "保存预设",
  selectPreset: "选择预设",
  noPresets: "暂无保存的预设",
  deletePreset: "删除预设",
  presetName: "预设名称",
  presetFull: "已保存 5 个预设（已满）",
  bgPrimary: "主背景",
  bgSecondary: "次背景",
  bgSidebar: "侧边栏",
  textPrimary: "主文字",
  accentColor: "强调色",
  language: "语言",
  chinese: "中文",
  english: "English",
  personal: "个人",
  personalSignInTitle: "登录后管理个人资料",
  personalSignInHint: "登录后可以同步昵称和头像，并在不同设备间使用云端工作区。",
  personalOpenSignIn: "登录 / 注册",
  personalSignedIn: "已登录",
  personalProfile: "个人资料",
  personalNickname: "昵称",
  personalNicknamePlaceholder: "输入一个容易记住的昵称",
  personalChangeNickname: "更换昵称",
  personalSaveNickname: "保存昵称",
  personalChangeAvatar: "更换头像",
  personalAvatarHint: "支持 JPG、PNG、WebP；选择后可拖动、缩放并裁剪圆形头像。",
  avatarCropTitle: "编辑头像",
  avatarCropHint: "拖动图片调整位置，缩放后让需要的内容完整落在圆形区域内。",
  avatarCropDragHint: "拖动调整位置",
  avatarCropZoom: "缩放头像",
  avatarCropZoomIn: "放大",
  avatarCropZoomOut: "缩小",
  avatarCropCancel: "取消",
  avatarCropConfirm: "使用此头像",
  avatarCropLoadFailed: "无法读取这张图片，请选择 JPG、PNG 或 WebP 文件。",
  avatarHistory: "历史头像",
  useHistoryAvatar: "使用这个头像",
  useHistoryBackground: "使用这个背景",
  deleteHistoryImage: "删除历史图片",
  personalSecurity: "账号安全",
  personalChangePassword: "修改密码",
  personalNewPassword: "新密码",
  personalConfirmPassword: "确认新密码",
  personalPasswordUpdated: "密码已更新",
  personalPasswordMismatch: "两次输入的新密码不一致",
  personalProfileUpdated: "昵称已更新",
  personalAvatarUpdated: "头像已更新",
  personalSignOutHint: "退出后仍可继续使用本地笔记，云端工作区需要重新登录。",
  personalDataHint: "个人资料会安全地保存在登录账户中，仅用于身份识别和同步展示。",
  personalNotConfigured: "登录服务尚未配置，请先完成 Supabase 配置。",
  personalSaving: "保存中...",
  personalChooseImage: "选择图片",
  close: "关闭",
  defaultFont: "默认字体",
  importFont: "导入字体",
  exportFile: "导出文件",
  exportFilterMarkdown: "Markdown 文件",
  exportFilterText: "纯文本文件",
  exportFilterWord: "Word 文档",
  exportFilterPdf: "PDF 文档",
  exportImagesDropped: "有 {count} 张图片未能写入文档，已在导出时跳过。",
  exportFailed: "导出失败：{message}",
  collapseSidebar: "收起边栏",
  expandSidebar: "展开边栏",
  enableAlwaysOnTop: "开启全局置顶",
  disableAlwaysOnTop: "关闭全局置顶",
  saved: "已保存",
  unsaved: "未保存",
  save: "保存",
  undo: "撤销",
  redo: "前进",
  insertTable: "插入表格（Ctrl+Alt+T）",
  insertImage: "插入图片",
  insertImageFailed: "图片插入失败：{message}",
  about: "关于",
  aboutTitle: "关于 Qing Notepad",
  version: "版本",
  author: "作者",
  sourceCode: "源代码",
  personalBlog: "个人博客",
  qqDiscussionGroup: "QQ 讨论群",
  copyQqGroupNumber: "复制 QQ 群号",
  friendSponsor: "友情赞助",
  minimize: "最小化",
  maximize: "最大化",
  restore: "还原",
  wordCount: "{count} 字",
  showWindow: "显示窗口",
  quitApp: "退出软件",
  hideToTray: "最小化到托盘",
  shortcutsSection: "快捷键设置",
  autoSaveSection: "自动保存",
  autoSaveOff: "关闭",
  autoSave10s: "10 秒",
  autoSave30s: "30 秒",
  autoSave1m: "1 分钟",
  stickyOpacity: "磁贴透明度",
  dataLocation: "数据保存位置",
  openDataFolder: "点击跳转",
  imageCache: "图片缓存",
  openImageCache: "点击跳转",
  trash: "回收站",
  trashRetention: "回收站保存时间",
  trashRetentionDisabled: "关闭",
  trashRetention7Days: "7 天",
  trashRetention30Days: "30 天",
  trashRetention90Days: "90 天",
  trashRetentionForever: "永久",
  trashHint: "删除的笔记先进入回收站，过期自动清理",
  trashEmpty: "回收站是空的",
  trashEmptyHint: "删除的笔记会出现在这里，可在保存时间内恢复。",
  trashRestore: "恢复",
  trashDeleteForever: "彻底删除",
  trashDeletedAt: "删除于 {time}",
  trashOriginalCategory: "原分类：{category}",
  trashRemaining: "剩余 {days} 天",
  trashRemainingLessThanDay: "不足 1 天",
  trashExpiresNever: "不会过期",
  trashRestored: "已恢复「{note}」",
  trashRestoreMissingImages: "有 {count} 张图片已失效",
  trashRestoreFailed: "恢复失败，请重试",
  trashConfirmDeleteMessage: "将永久删除「{note}」，此操作不可恢复。",
  trashClearAll: "清空回收站",
  trashConfirmClearMessage: "回收站内 {count} 条笔记将被永久删除，此操作不可恢复。",
  trashDisabled: "回收站已关闭",
  trashDisabledHint: "关闭状态下删除的笔记无法恢复，可随时在设置中重新开启。",
  trashOpenSettings: "打开设置",
  trashLoading: "正在加载…",
  moveNoteToTrash: "移入回收站",
  confirmMoveToTrashMessage: "将「{note}」移入回收站，可恢复。保存时间：{days}。",
  shortcutToggleWindow: "显示/隐藏窗口",
  shortcutPinSticky: "钉住磁贴",
  resetShortcuts: "恢复默认",
  pressShortcut: "按下快捷键...",
  pinSticky: "钉住磁贴",
  unpinSticky: "取消钉住",
  stickyNote: "磁贴笔记",
  stickyEmptyHint: "双击此处开始编辑…",
  pinNote: "置顶笔记",
  unpinNote: "取消置顶",
  tileNoNote: "没有选中的笔记",
  checkUpdate: "检查更新",
  checkingUpdate: "检查中...",
  upToDate: "已是最新版本",
  newVersion: "发现新版本 v{version}",
  downloadUpdate: "下载更新",
  checkUpdateFailed: "检查更新失败",
  updateAvailableTitle: "发现新版本",
  updateAvailableMessage: "Qing Notepad v{version} 已发布，是否立即更新？",
  currentVersion: "当前版本",
  latestVersion: "最新版本",
  updateNow: "立刻更新",
  updateLater: "稍后更新",
  neverRemind: "不再提醒",
  aiAssistant: "小青",
  aiSettings: "AI 设置",
  aiApiKey: "DeepSeek API Key",
  aiApiKeyPlaceholder: "sk-...",
  aiApiKeyHint: "在 platform.deepseek.com 创建。仅保存在本机，经系统加密。",
  aiSaveKey: "保存",
  aiClearKey: "清除",
  aiVerifyKey: "测试连接",
  aiKeySaved: "API Key 已保存",
  aiKeyCleared: "API Key 已清除",
  aiKeyMissing: "尚未配置 API Key",
  aiVerifySuccess: "连接正常",
  aiPrivacyNoticeTitle: "隐私说明",
  aiPrivacyNoticeBody:
    "使用 AI 功能时，你选中的段落、检索到的笔记片段与提问会发送至你在「AI 接口」里配置的服务地址，由该服务生成回复。知识库检索在你本机完成，API Key 经系统加密后仅存于本机。",
  aiPrivacyAgree: "我知道了",
  aiErrorUnauthorized: "API Key 无效，请检查后重试",
  aiErrorBalance: "账户余额不足",
  aiErrorRateLimit: "请求过于频繁，请稍后再试",
  aiErrorNetwork: "网络连接失败，请检查网络后重试",
  aiErrorServer: "服务暂时不可用",
  aiErrorBadResponse: "返回内容异常，请重试",
  aiErrorMissingKey: "请先配置 API Key",
  aiErrorAborted: "已停止生成",
  aiSidebarHint: "我是小青，问我任何关于青记使用的问题，答案来自内置功能手册。",
  aiInputPlaceholder: "例如：怎么把笔记导出为 PDF？",
  aiSend: "发送",
  aiStop: "停止",
  aiClearChat: "清空对话",
  aiThinking: "正在思考…",
  aiPhaseRetrieving: "正在检索本地知识库…",
  aiPhaseWriting: "正在处理笔记…",
  aiTruncated: "回答达到长度上限，内容可能被截断。",
  aiViewDiff: "查看改动",
  aiDiffTooLong: "内容过长，仅显示前 400 行。",
  aiDiffUnavailable: "原始版本已不可用。",
  aiReasoning: "思考过程",
  aiNoResult: "手册里没有找到相关内容，换个说法试试。",
  aiNoKeyHint: "未配置 API Key，当前由小青离线检索、流式作答。在「设置 → AI 设置」里添加接口后可获得生成式完整回答。",
  aiModelLabel: "对话模型",
  aiModelLocal: "小青",
  aiModelLocalSub: "本地检索，不联网",
  aiModelSection: "模型",
  aiModelAdd: "管理接口与模型",
  aiModelNoEndpoint: "还没有可用模型。到「设置 → AI 设置」添加接口，勾选要用的模型。",
  aiThinkingTitle: "思考强度",
  aiThinkingOff: "关闭",
  aiThinkingLow: "低",
  aiThinkingHigh: "高",
  aiThinkingEffectOff: "不发送思考参数",
  aiThinkingEffectLow: "低强度推理",
  aiThinkingEffectHigh: "高强度推理",
  aiEndpointTitle: "API 接口",
  aiEndpointHint: "自己填地址与 Key，配什么就用什么",
  aiEndpointEmpty:
    "还没有配置任何接口。点下方按钮添加，或从常见服务里选一个填好地址再补 Key。",
  aiEndpointUntitled: "未命名接口",
  aiEndpointNoUrl: "尚未填写地址",
  aiEndpointModelCount: "{on}/{total} 个模型",
  aiEndpointName: "名称",
  aiEndpointNamePlaceholder: "例如 Kimi",
  aiEndpointBaseUrl: "接口地址（Base URL）",
  aiEndpointKey: "API Key",
  aiEndpointKeySet: "已保存，输入新值可覆盖",
  aiEndpointKeyPlaceholder: "sk-...",
  aiEndpointModels: "模型",
  aiEndpointSearch: "搜索模型",
  aiEndpointSearching: "正在搜索…",
  aiEndpointNoModels: "还没有模型。填好地址与 Key 后点「搜索模型」。",
  aiEndpointThinkingHint: "该模型是否支持深度思考（不支持时不发送思考参数）",
  aiEndpointModelsHint: "勾选的模型才会出现在聊天栏的模型列表里。",
  aiEndpointDelete: "删除接口",
  aiEndpointDeleteConfirm: "确认删除",
  aiEndpointDeleteSessions: "{count} 段会话将一并删除，不可恢复。",
  aiEndpointCancel: "取消",
  aiEndpointAdd: "添加接口",
  aiEndpointCustom: "自定义",
  aiActPolish: "润色",
  aiActRewrite: "改写",
  aiActContinue: "续写",
  aiActSummarize: "摘要",
  aiActTranslate: "翻译",
  aiActChecklist: "转待办",
  aiActCardHint: "结果只读，不会覆盖原文",
  aiCardTitle: "结果",
  aiCardCopy: "复制",
  aiCardCopied: "已复制",
  aiCardPoints: "要点",
  aiCardTags: "标签",
  aiSmallTalkGreeting:
    "你好，我是小青，本地离线知识检索模型，暂不具备智能对话能力喔~ 不过「青记」怎么用，你尽管问我。",
  aiSmallTalkIdentity:
    "我是小青，青记内置的本地离线知识检索模型。我不能闲聊，也不会生成式作答，但可以在离线状态下检索内置手册、你的笔记、待办和画布内容，回答青记的用法问题。",
  panelCrashTitle: "这块内容出错了",
  panelCrashBody: "界面渲染时出现异常，其他区域不受影响。可以重试，或重启应用。",
  panelCrashRetry: "重试",
  aiPolishModelLabel: "润色模型",
  aiAnswerSteps: "操作步骤",
  aiAnswerHowto: "这样做",
  aiAnswerWhere: "在哪找",
  aiAnswerWhereAlt: "位置",
  aiAnswerVerdict: "结论",
  aiAnswerExplain: "说明",
  aiAnswerExcerpt: "原文补充",
  aiExampleQ1: "怎么把笔记导出为 PDF？",
  aiExampleQ2: "关闭窗口后程序去哪了？",
  aiExampleQ3: "如何备份我的笔记？",
  aiExampleQ4: "怎么把笔记导出为 Word 文档？",
  aiExampleQ5: "笔记能按标签分类吗？",
  aiExampleQ6: "怎么同时打开多篇笔记？",
  aiExampleQ7: "删掉的笔记能恢复吗？",
  aiExampleQ8: "便签和磁贴有什么区别？",
  aiExampleQ9: "怎么自定义全局快捷键？",
  aiExampleQ10: "怎么切换深色主题？",
  aiExampleQ11: "换电脑后怎么迁移笔记？",
  aiExampleQ12: "待办能设优先级吗？",
  aiShuffleExamples: "换一批",
  aiClose: "关闭",
  aiCopy: "复制",
  aiCopied: "已复制",
  aiRegenerate: "重新生成",
  aiDeleteMessage: "删除这条对话",
  aiClearConfirmTitle: "清空对话？",
  aiClearConfirmBody: "将删除当前所有问答记录，此操作不可撤销。",
  aiClearConfirmOk: "清空",
  aiCancel: "取消",
  aiGreeting: "你好，我是小青。有什么关于青记的问题，直接问我就好。",
  aiEmptyGreetingApi:
    "当前由 {channel} 的 {model} 作答。可以问青记的用法，也可以让我读你的笔记。",
  aiEmptyGreetingModel:
    "当前由 {model} 作答。可以问青记的用法，也可以让我读你的笔记。",
  aiEmptyGreetingNoKey: "「{channel}」还没有配置 API Key。到「设置 → AI 设置」填好后就能对话。",
  aiStatusReady: "已连接",
  aiStatusNoKey: "未配置 Key",
  aiNewChat: "新建会话",
  aiHistory: "历史会话",
  aiRename: "重命名",
  aiDeleteConversation: "删除会话",
  aiDeleteConversationTitle: "删除该会话？",
  aiDeleteConversationBody: "该会话的所有问答记录将被删除，不可恢复。",
  aiNoConversations: "暂无历史会话",
  aiUntitled: "未命名会话",
  aiPolishTitle: "AI 润色",
  aiPolishEntry: "AI 润色选中内容",
  aiPolishNoSelection: "请先在编辑器中选中要润色的文字",
  aiPolishPlaceholder: "可选：补充改写要求，如「改成更正式的语气」",
  aiPolishGenerate: "生成改写",
  aiPolishApply: "应用到笔记",
  aiPolishUndo: "撤销本次修改",
  aiPolishApplied: "已应用到笔记",
  aiPolishBack: "返回对话",
  aiPolishStylePolish: "润色",
  aiPolishStyleConcise: "更简洁",
  aiPolishStyleFormal: "更正式",
  aiPolishStyleCasual: "更口语化",
  aiDiffBefore: "修改前",
  aiDiffAfter: "修改后",
  aiPolishStale: "笔记内容已变化，请重新选择后重试",
  aiPermLabel: "笔记修改权限",
  aiPermReadOnly: "仅助手",
  aiPermFull: "完全开放",
  aiPermLocalOnly: "小青为本地只读检索；切换到 API 模型后可开启笔记写入",
  aiPermConfirmTitle: "开启「完全开放」权限？",
  aiPermConfirmBody: "AI 将可以直接修改笔记正文与标题，修改立即生效。每次修改都会保存快照，可在对应消息下逐条撤销。",
  aiPermConfirmOk: "开启",
  aiEditApplied: "已修改笔记",
  aiUndoEdit: "撤销此次修改",
  aiEditUndone: "已撤销",
  helpMenu: "帮助",
  helpManual: "功能手册",
  helpFaq: "常见问题",
  helpShortcuts: "快捷键一览",
  helpReportIssue: "报告问题",
  helpShortcutsNote: "以下为固定快捷键，暂不支持自定义（显示/隐藏窗口除外）。",
  shortcutGroupGlobal: "全局",
  shortcutGroupNote: "笔记编辑",
  shortcutGroupTabs: "标签页",
  shortcutGroupCanvas: "画布",
  shortcutSaveNote: "保存当前笔记",
  shortcutCloseTab: "关闭当前标签页",
  shortcutInsertTable: "插入表格",
  shortcutUndoRedo: "撤销 / 重做",
  retry: "重试",
  quitConfirmTitle: "退出青记？",
  quitConfirmMessage: "退出后将关闭所有便签与磁贴窗口，未保存的修改会先写入本地。",
  updateCheckErrorDetail: "失败原因：{detail}",
  importFailed: "导入失败：{message}",
  loading: "正在加载…",
  authSignedOut: "未登录",
  pluginsTitle: "扩展",
  pluginsSearchPlaceholder: "搜索扩展",
  pluginsInstalledSection: "已安装",
  pluginsAvailableSection: "可安装",
  pluginsEmptyInstalled: "还没有安装扩展",
  pluginsEmptyAvailable: "暂无可用插件",
  pluginsOfflineHint: "离线，数据可能是旧的",
  pluginsIndexLoading: "正在获取扩展索引…",
  pluginsInstallFromFile: "从文件安装",
  pluginsInstallFromFolder: "从文件夹安装",
  pluginsRefreshIndex: "刷新索引",
  pluginsOnline: "在线",
  pluginsOffline: "离线",
  pluginsSelectHint: "未选择扩展",
  pluginsSelectHintBody: "在左侧选择一个扩展查看详情。扩展只能往命令面板里加命令，不会改动界面。",
  pluginsSidebarFooterHint: "扩展代码在独立线程中运行，不能联网。",
  pluginVersion: "版本",
  pluginAuthor: "作者",
  pluginRepository: "仓库",
  pluginLicense: "许可",
  pluginPermissions: "权限",
  pluginPermissionsNone: "不需要任何权限",
  pluginCommands: "命令",
  pluginNoCommands: "没有提供命令",
  pluginInstall: "安装",
  pluginUpdate: "更新",
  pluginUninstall: "卸载",
  pluginUninstallTitle: "卸载 {name}？",
  pluginUninstallBody: "扩展文件会被删除。保留设置数据后，重新安装仍可沿用。",
  pluginUninstallKeep: "保留数据并卸载",
  pluginUninstallDrop: "全部删除",
  pluginRollback: "回滚",
  pluginEnable: "启用",
  pluginDisable: "停用",
  pluginEnabled: "已启用",
  pluginDisabled: "已停用",
  pluginRunning: "运行中",
  pluginNotRunning: "未运行",
  pluginSourceIndex: "来自扩展索引",
  pluginSource: "来源",
  pluginInfo: "信息",
  pluginSourceFile: "本地文件安装",
  pluginViewLog: "错误日志",
  pluginLogEmpty: "没有错误记录",
  pluginLogTitle: "错误日志（最近 100 条）",
  pluginUpdateAvailable: "有可用更新",
  pluginPermissionRevoke: "撤销",
  pluginPermissionNew: "新增",
  pluginPermissionGrant: "授予",
  pluginLockedNote: "撤销后，扩展再调用这项能力会被直接拒绝。",
  pluginPermPromptInstallTitle: "安装 {name}？",
  pluginPermPromptUpdateTitle: "更新 {name}？",
  pluginPermPromptBody: "这个扩展将获得以下权限：",
  pluginPermPromptAddedBody: "新版本需要这些新增权限：",
  pluginPermPromptApprove: "同意并安装",
  pluginPermPromptUpdate: "同意并更新",
  pluginPermPromptCancel: "取消",
  pluginPermStorage: "保存该扩展的设置",
  pluginPermNotesRead: "读取你的笔记",
  pluginPermNotesWrite: "修改你的笔记",
  pluginPermTodoRead: "读取你的待办",
  pluginPermTodoWrite: "修改你的待办",
  pluginPermClipboardRead: "读取剪贴板",
  pluginPermClipboardWrite: "写入剪贴板",
  pluginPermNotify: "显示提示消息",
  pluginPermEditorRead: "读取当前笔记正文",
  pluginPermEditorWrite: "修改当前笔记",
  pluginPermEditorDecorate: "在正文上做标记",
  pluginPermViews: "贡献侧边栏视图",
  pluginPermEditorSelection: "移动你的光标与滚动位置",
  pluginCrashedDisabled: "{name} 连续崩溃，已自动停用",
  pluginPermissionDenied: "扩展缺少权限：{permission}",
  pluginInstalled: "已安装 {name}",
  pluginUpdated: "已更新 {name}",
  pluginUninstalled: "已卸载 {name}",
  pluginRolledBack: "已回滚到 {version}",
  pluginCommandFailed: "命令执行失败：{code}",
  pluginInstallFailed: "安装失败：{message}",
  pluginHostIncompatible: "该扩展不支持当前应用版本",
  pluginApiIncompatible: "该扩展的接口版本不受支持",
  pluginCommandConflict: "命令 ID 已被占用：{ids}",
  pluginNativeModule: "包内有原生模块，不能安装",
  pluginPackageTooLarge: "安装包超过 20 MB 上限",
  pluginManifestMissing: "包里没有清单：根目录需要 package.json（带 main）或 plugin.json",
  pluginManifestInvalid: "扩展清单有误：{detail}",
  pluginMissingMain: "清单里的入口文件不在包里：{detail}",
  pluginTooManyFiles: "包内文件数超过 2000 个上限",
  pluginPermissionUnknown: "清单声明了未知权限：{detail}",
  pluginEntryNameInvalid: "包内有非法的文件名，可能是伪装过的压缩包",
  pluginIndexPermissionMismatch: "索引里写的权限与安装包不一致，已拒绝安装：{detail}",
  commandPaletteTitle: "命令面板",
  commandPalettePlaceholder: "输入命令名称…",
  commandPaletteEmpty: "没有匹配的命令",
  commandPaletteHint: "↑↓ 选择 · Enter 执行 · Esc 关闭",
  commandCategoryView: "视图",
  commandCategoryNote: "笔记",
  commandCategoryApp: "应用",
  commandCategoryPlugin: "扩展",
  commandNewNote: "新建笔记",
  commandOpenSettings: "打开设置",
  commandToggleAi: "切换 AI 助手",
  settingsPlugins: "扩展",
  pluginsSettingsOpen: "打开扩展页",
  pluginsSettingsOpenHint: "安装、启用、卸载和权限管理都在扩展页完成。",
  pluginsDisableAll: "禁用所有插件",
  pluginsDisableAllHint: "临时停用全部扩展，已安装的文件保留。",
};

const en: TranslationKeys = {
  explorer: "Explorer",
  imageHost: "Image Host",
  canvas: "Canvas",
  canvasSelect: "Select",
  canvasPan: "Pan",
  canvasInsert: "Insert",
  canvasDraw: "Draw",
  canvasArrange: "Arrange",
  canvasView: "View",
  canvasStyle: "Style",
  canvasAddImage: "Add image",
  canvasAddText: "Add text",
  canvasDoodlePen: "Doodle pen",
  canvasDoodleEraser: "Doodle eraser",
  canvasDoodleColor: "Pen color",
  canvasDoodleWidth: "Pen width",
  canvasEraserShape: "Eraser shape",
  canvasEraserCircle: "Circle",
  canvasEraserSquare: "Square",
  canvasEraserSize: "Eraser size",
  canvasEraserOpacity: "Eraser opacity",
  canvasClearDoodles: "Clear page doodles",
  canvasZoomOut: "Zoom out",
  canvasZoomIn: "Zoom in",
  canvasResetZoom: "Reset zoom",
  canvasFit: "Fit canvas",
  canvasMoveLayerUp: "Move layer up",
  canvasMoveLayerDown: "Move layer down",
  canvasDelete: "Delete object",
  canvasExport: "Export",
  canvasExporting: "Exporting…",
  canvasSaved: "Saved",
  canvasSaving: "Saving…",
  canvasEmpty: "Your canvas is empty",
  canvasPasteHint: "Paste a screenshot, drop an image, or add text and structure nodes",
  canvasLoading: "Loading canvas…",
  canvasGuideTitle: "Canvas guide",
  canvasGuideSelect: "Select: drag an object, Shift-click for multi-select, or resize from its bottom-right handle",
  canvasGuidePan: "Pan: choose Pan, or hold Space while dragging",
  canvasGuideAdd: "Add: insert images, text, or structure nodes; choose a connector and click two nodes",
  canvasGuideZoom: "Zoom: hold Ctrl/Cmd + wheel for the canvas; wheel a selected image to resize it or selected text to change its size",
  canvasGuideEdit: "Edit: double-click text or a node for rich text; select objects and use Ctrl/Cmd+X, C, or V to cut, copy, and paste",
  canvasGuideOverview: "Minimap: see all object positions and the current viewport in the lower-right; click an object to center on it",
  canvasOverview: "Canvas overview",
  canvasNew: "New canvas",
  canvasNamePlaceholder: "Canvas name",
  canvasRename: "Rename canvas",
  canvasDeleteQuestion: "Delete \"{name}\"?",
  canvasDeleteCanvas: "Delete canvas",
  canvasOpenList: "Open canvas list",
  canvasCloseList: "Close canvas list",
  canvasNodeText: "Node",
  canvasShapeRectangle: "Rectangle node",
  canvasShapeRounded: "Rounded node",
  canvasShapeEllipse: "Ellipse node",
  canvasShapeDiamond: "Decision node",
  canvasConnectorStraight: "Straight arrow",
  canvasConnectorOrthogonal: "Orthogonal arrow",
  canvasDuplicate: "Duplicate selection",
  canvasAlignHorizontal: "Align horizontal centers",
  canvasAlignVertical: "Align vertical centers",
  canvasShapeFill: "Node fill color",
  canvasShapeStroke: "Border or connector color",
  canvasFill: "Fill",
  canvasStroke: "Stroke",
  canvasTextStyle: "Text style",
  canvasParagraph: "Paragraph",
  canvasFontSize: "Font size",
  canvasFontFamily: "Font family",
  canvasDefaultFont: "Default font",
  canvasBold: "Bold",
  canvasItalic: "Italic",
  canvasUnderline: "Underline",
  canvasStrike: "Strikethrough",
  canvasHighlight: "Highlight",
  canvasTextColor: "Text color",
  canvasBulletList: "Bullet list",
  canvasOrderedList: "Ordered list",
  canvasQuote: "Blockquote",
  canvasAlignLeft: "Align left",
  canvasAlignCenter: "Align center",
  canvasAlignRight: "Align right",
  canvasDone: "Done",
  canvasOpenTile: "Open canvas tile",
  canvasTile: "Canvas tile",
  canvasTileLoading: "Loading canvas tile…",
  canvasPinTile: "Pin tile",
  canvasUnpinTile: "Unpin tile",
  todo: "Todo List",
  notepad: "Notepad",
  newNote: "New Note",
  importMd: "Import Markdown",
  importTxt: "Import Text",
  importNote: "Import File",
  comingSoon: "Coming Soon",
  notes: "Notes",
  categories: "Categories",
  allNotes: "All Notes",
  uncategorizedNotes: "Uncategorized",
  newCategory: "New Category",
  renameCategory: "Rename Category",
  deleteCategory: "Delete Category",
  newSubfolder: "New subfolder",
  unnamedFolder: "Unnamed folder",
  renameNote: "Rename note",
  moveToFolder: "Move to folder",
  pinCategory: "Pin category",
  unpinCategory: "Unpin category",
  confirmDeleteCategory: 'Delete category "',
  dragCategory: "Drag Category",
  resizeCategoryPanel: "Resize category panel",
  resizeCategoryPanelHint: "Drag to resize the category panel, double-click to reset",
  dragNote: "Drag Note",
  expandFolder: "Expand folder",
  collapseFolder: "Collapse folder",
  moveNoteToCategoryConfirm: 'Move "{note}" note to "{category}" folder?',
  tags: "Tags",
  all: "All",
  settings: "Settings",
  authSignIn: "Sign In",
  authSignUp: "Create Account",
  authSignOut: "Sign Out",
  authAccount: "Account",
  authWelcome: "Sign in to Qing Notepad",
  authSubtitle: "Sign in to use online workspaces",
  authSignedIn: "Currently signed in",
  authEmail: "Email",
  authPassword: "Password",
  authConfirmPassword: "Confirm Password",
  authShowPassword: "Show password",
  authHidePassword: "Hide password",
  authPasswordPlaceholder: "At least 6 characters",
  authPasswordTooShort: "Password must be at least 6 characters",
  authPasswordMismatch: "The passwords do not match",
  authCheckEmail: "Account created. Check your email to confirm it before signing in.",
  authWorking: "Working...",
  authAutoSigningIn: "Signing in automatically",
  authRememberPassword: "Remember password",
  authAutoLogin: "Auto login",
  authForgotPassword: "Forgot password?",
  authForgotPasswordTitle: "Recover password",
  authForgotPasswordHint: "Enter your account email and we will send a password recovery link.",
  authSendResetEmail: "Send reset email",
  authResendResetEmail: "Resend",
  authChangeResetEmail: "Change email",
  authResetEmailRequired: "Enter your account email first",
  authResetEmailSent: "Reset email sent. Copy the reset link from the email.",
  authManualRecoveryHint: "Right-click the reset-password button in the email, copy its link, and paste it here.",
  authRecoveryLinkPlaceholder: "Paste the full password recovery link",
  authVerifyRecoveryLink: "Verify link and continue",
  authRecoveryLinkRequired: "Paste the password recovery link from the email first",
  authResetPasswordTitle: "Set a new password",
  authResetPasswordHint: "The recovery link is verified. Enter your new password.",
  authNewPassword: "New password",
  authSetNewPassword: "Update password",
  authRecoveryLinkInvalid: "This recovery link is invalid or expired. Request a new reset email.",
  authPasswordResetSuccess: "Password updated successfully",
  authPasswordResetDone: "Done",
  authNotConfigured: "Sign-in is not configured",
  authNotConfiguredHint: "Add the Supabase Project URL and publishable/anon key to .env.local, then restart the app.",
  workspace: "Workspace",
  workspaceTitle: "Online Workspace",
  workspaceOverview: "Overview",
  overviewDocuments: "Documents",
  overviewMembers: "Members",
  overviewRecent: "Recently edited",
  overviewRecentEmpty: "Nothing edited yet",
  overviewRecentEmptyHint: "Create a cloud document and it will show up here",
  overviewOwnerTools: "Workspace admin",
  overviewInviteCode: "Invite code",
  overviewCopyInvite: "Copy invite code",
  overviewCopied: "Copied",
  overviewPendingPublish: "To publish",
  overviewBackToOverview: "Back to overview",
  overviewNoWorkspaceTitle: "No workspace yet",
  overviewNoWorkspaceHint: "Create one, or join with an invite code",
  overviewReadOnlyHint: "You are a viewer here: browsing only",
  overviewUpdatedAt: "Updated",
  workspaceLoginRequired: "Sign in to use workspaces",
  workspaceLoginHint: "Create or join a collaborative workspace after signing in",
  createWorkspace: "Create Workspace",
  joinWorkspace: "Join Workspace",
  workspaceAlreadyJoined: "You have already joined this workspace",
  workspaceName: "Workspace name",
  workspaceNameHint: "Only the workspace creator can change its name",
  renameWorkspace: "Rename Workspace",
  saveWorkspaceName: "Save name",
  inviteCode: "Invite code",
  inviteRole: "New member role",
  manageWorkspace: "Manage Workspace",
  permissionManagement: "Permissions",
  permissionManagementHint: "Manage member roles and document access in one place",
  workspaceSettings: "Workspace Settings",
  shareWorkspace: "Share Workspace",
  copyInvite: "Copy invite code",
  copied: "Copied",
  regenerateInvite: "Regenerate code",
  newCloudDocument: "New Cloud Document",
  newCloudDocumentHint: "Create a draft and collaborate in this workspace",
  renameCloudDocument: "Rename Document",
  documentActions: "Document actions",
  dragCloudDocument: "Drag cloud document up or down",
  documentDetails: "Document details",
  deleteCloudDocument: "Delete Document",
  cloudDocumentName: "Document name",
  documentCreator: "Creator",
  publicationStatus: "Publication status",
  collaborationMode: "Collaboration mode",
  realTimeCollaboration: "Live cloud collaboration",
  publishedAt: "Published",
  cloudDocumentDraft: "Draft",
  cloudDocumentUnpublished: "Unpublished",
  cloudDocumentScheduled: "Scheduled",
  cloudDocumentPublished: "Published",
  manageCloudDocumentPublication: "Publication settings",
  publishCloudDocumentNow: "Publish now",
  scheduleCloudDocument: "Schedule publication",
  rescheduleCloudDocument: "Change publish time",
  cancelScheduledPublish: "Cancel schedule",
  scheduledPublishTime: "Publish time",
  scheduledPublishHour: "Hour",
  scheduledPublishMinute: "Minute",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  scheduledPublishFuture: "Choose a publish time in the future",
  cloudDocumentPublishUnsynced: "Wait for the current changes to finish syncing before publishing",
  cloudDocumentPublicationHint: "Publishing opens the document to all members. You can also change access directly in Permission Management.",
  cloudDocumentPublishedHint: "This document is open to all members. Unpublishing restricts it to creators and managers.",
  unpublishCloudDocument: "Unpublish to draft",
  cloudDocumentUnpublishWarning: "Members will lose access immediately, including anyone who already has the document open. Continue?",
  confirmUnpublishCloudDocument: "Confirm unpublish",
  keepCloudDocumentPublished: "Keep published",
  documentPermissions: "Document access",
  documentPermissionsHint: "Give each document its own audience. Access is enforced by the server.",
  documentAccessLevel: "Access level",
  accessCreator: "Creator only",
  accessManagers: "Creator and managers",
  accessMembers: "All members",
  accessCreatorHint: "Only the workspace creator can view and edit",
  accessManagersHint: "Creators and managers can view and edit",
  accessMembersHint: "Members can read; creators and managers can edit",
  transferCreator: "Transfer creator",
  confirmTransferCreator: "Confirm transfer",
  transferCreatorWarning: "After transferring creator access to “{member}”, you will become a manager. Only the new creator can manage member permissions or delete the workspace.",
  memberPermissions: "Member permissions",
  memberPermissionsHint: "There is one creator. Managers maintain documents; members receive read-only access by document.",
  currentUser: "You",
  workspaceDocuments: "Shared documents",
  noWorkspaces: "No workspace yet. Create or join one.",
  noCloudDocuments: "No documents in this workspace",
  noFilteredCloudDocuments: "No documents match this publication status",
  noCloudDocumentsReadOnly: "You are a member of this workspace and no documents are currently available to you",
  workspaceMembers: "Workspace Members",
  roleOwner: "Creator",
  roleEditor: "Manager",
  roleViewer: "Member",
  removeMember: "Remove member",
  confirmRemoveMember: 'Remove “{member}” from the “{workspace}” workspace? They will no longer be able to access its documents.',
  removedFromWorkspaceTitle: "Removed from workspace",
  removedFromWorkspaceMessage: 'You were removed from the “{workspace}” workspace and can no longer access its documents.',
  acknowledge: "Got it",
  leaveWorkspace: "Leave Workspace",
  deleteWorkspace: "Delete Workspace",
  confirmDeleteWorkspace: 'Delete "{workspace}" workspace and all of its documents?',
  confirmDeleteCloudDocument: 'Delete "{document}" cloud document?',
  collaborationConnecting: "Connecting",
  collaborationConnected: "Live sync",
  collaborationDisconnected: "Editing offline",
  collaborationError: "Collaboration failed",
  collaborationNotConfigured: "Collaboration server URL is not configured",
  collaborationNetworkGood: "Good network",
  collaborationNetworkFair: "Fair network",
  collaborationNetworkSlow: "Slow network",
  collaborationNetworkUnstable: "Unstable network",
  collaborationNetworkHistory: "Network history",
  collaborationNetworkCurrent: "Current",
  collaborationNetworkMinimum: "Minimum",
  collaborationNetworkMaximum: "Maximum",
  collaborationNetworkSlowest: "Slowest",
  collaborationNetworkAverage: "Average",
  collaborationNetworkP95: "P95",
  collaborationSyncBacklog: "Sync backlog",
  collaborationNetworkThresholds: "Thresholds",
  collaborationNetworkWaiting: "Waiting for samples",
  collaborationLocalProtection: "Local protection",
  collaborationSyncPending: "Waiting to sync",
  collaborationLocalFallback: "Changes are safe on this device and will sync when the connection recovers",
  onlineUsers: "Online",
  userHighlights: "User highlights",
  synchronizedScroll: "Synchronized scroll",
  independentScroll: "Independent scroll",
  readOnly: "Read only",
  cloudSavedRealtime: "Changes are saved in real time",
  workspaceBackendNotReady: "The workspace database is not initialized. Run the provided migration in the Supabase SQL Editor first.",
  noNotes: 'No notes yet. Click "New Note" to start',
  untitled: "Untitled",
  noteTabs: "Note tabs",
  closeTab: "Close tab",
  closeOtherTabs: "Close other tabs",
  closeTabsToRight: "Close tabs to the right",
  closeAllTabs: "Close all tabs",
  pinTab: "Pin tab",
  previewTabHint: "Preview tab - double-click or edit to pin",
  scrollTabsLeft: "Scroll tabs left",
  scrollTabsRight: "Scroll tabs right",
  confirmDelete: 'Delete note "',
  confirmDeleteNoteMessage: 'Delete "{note}" note?',
  confirmYes: "Yes",
  confirmNo: "No",
  deleteNote: "Delete Note",
  deleteTodo: "Delete Todo",
  confirmDeleteTodoMessage: 'Delete "{todo}" todo?',
  todoLists: "Task Lists",
  newTodoList: "New List",
  newTodo: "New Todo",
  defaultTodoList: "My List",
  listNamePlaceholder: "Enter list name",
  renameTodoList: "Rename List",
  deleteTodoList: "Delete List",
  confirmDeleteTodoListMessage: 'Delete “{list}” and its {count} tasks? This cannot be undone.',
  pinTodoList: "Pin List",
  unpinTodoList: "Unpin List",
  dragTodoList: "Drag List",
  todoTitle: "Todo List",
  totalStats: "{total} items, {done} completed",
  priorityFilter: "Priority",
  addTaskPlaceholder: "Add a new task...",
  lowPriority: "Low Priority",
  mediumPriority: "Medium Priority",
  highPriority: "High Priority",
  dueDate: "Due Date",
  noDueDate: "Due",
  clearDueDate: "Clear due date",
  add: "Add",
  filterAll: "All",
  filterActive: "Active",
  filterCompleted: "Completed",
  filterPriority: "All Priorities",
  noCompleted: "No completed tasks yet",
  allDone: "All tasks are done!",
  noTodos: "No todos yet, add one",
  noTodosHint: "Type the first one in the bar above and press Enter.",
  searchNoResults: "No matching notes",
  searchNoResultsHint: "Try another keyword, or clear the search box to see everything.",
  pinTodo: "Pin Todo",
  unpinTodo: "Unpin Todo",
  subtask: "Subtask",
  addSubtask: "Add subtask",
  expandSubtasks: "Expand subtasks",
  collapseSubtasks: "Collapse subtasks",
  expandList: "Expand list",
  collapseList: "Collapse list",
  newTaskInList: "New task in this list",
  deleteSubtask: "Delete subtask",
  confirmDeleteTodoWithSubtasks: 'Delete "{todo}" and its {count} subtasks?',
  todoDescription: "Description",
  addTodoDescription: "Add a description",
  editTodoDescription: "Edit description",
  todoDescriptionPlaceholder: "Details, links, or acceptance criteria…",
  low: "Low",
  medium: "Med",
  high: "High",
  noteTitlePlaceholder: "Note title...",
  createdAt: "Created",
  updatedAt: "Updated",
  selectNote: "Select a note to start editing",
  orCreateNote: 'Or click "New Note" on the left',
  sourceEditor: "Source",
  preview: "Preview",
  mdViewSource: "Source",
  mdViewPreview: "Preview",
  mdViewSplit: "Split",
  mdPlaceholder: "Type Markdown source here...",
  inputTagName: "Enter tag name:",
  toggleToolbar: "Toolbar",
  settingsTitle: "Settings",
  settingsBasic: "General",
  settingsTheme: "Theme",
  settingsStorage: "Storage",
  storageCurrent: "Data directory",
  storageBadgeDefault: "Default (install folder)",
  storageBadgeCustom: "Custom",
  storageUsage: "{files} files · {size}",
  storageChangeDir: "Change directory",
  storageRestoreDefault: "Restore default",
  storageUnavailable: "The data directory is unavailable (drive disconnected or moved?): {path}",
  storageMigrateTitle: "Move data directory",
  storageMigrateBody: "Move every note, image and AI record to:\n{path}\n\nThe target folder must be empty. The app restarts when the move finishes.",
  storageMigrating: "Moving… {files} / {total} files",
  storageMigratingStart: "Measuring and preparing the move…",
  storageMigrateDone: "Moved {files} files ({size}). Restarting.",
  storageMigrateFailed: "Move failed: {message}",
  storageRestoreMigrateBody: "Everything in the current data directory will be moved back to:\n{path}\n\nConfig files the app regenerated there are replaced; nothing else is touched. The app restarts when it finishes.",
  storageAdoptBody: "That folder already holds data ({files} files) and looks like a real data directory.\nSwitching to it moves and deletes nothing; the current directory keeps its files.",
  storageNotALibrary: "That folder is not empty and does not look like a Qing Notepad data directory (no notes/ or settings.json). Pick an empty folder or an existing data directory.",
  storageReloading: "Restarting…",
  dialogConfirm: "OK",
  dialogCancel: "Cancel",
  themeColor: "Theme",
  darkTheme: "Dark",
  blueTheme: "Blue",
  yellowTheme: "Moody Yellow",
  greenTheme: "Fresh Green",
  customTheme: "Custom",
  customPalette: "Custom Palette",
  customBackground: "Custom Background",
  customBackgroundHint: "Supports JPG, PNG, and WebP. The image fills the main view and is stored in img-need.",
  backgroundHistory: "Background History",
  chooseBackground: "Choose Background",
  replaceBackground: "Replace Background",
  removeBackground: "Remove Background",
  backgroundUploadFailed: "Failed to upload background image",
  glassGroup: "Frosted Glass",
  glassGroupHint: "Panel translucency and blur. A wallpaper shows through the panels.",
  glassEnable: "Enable frosted glass",
  glassBaseGroup: "Base (always)",
  glassBgGroup: "Only with a wallpaper",
  glassBlur: "Blur",
  glassTint: "Side panel tint opacity",
  glassSaturate: "Saturation",
  glassNeedsBackground: "Set a background image first",
  glassBlurNeedsLowerTint: "Blur only shows below 60% tint",
  glassBaseOverridden: "Overridden by the wallpaper group below",
  glassReducedTransparency:
    "Transparency effects are off in Windows, so frosted glass is disabled. Turn them on in Settings → Personalisation → Colours.",
  savePreset: "Save Preset",
  selectPreset: "Select Preset",
  noPresets: "No saved presets",
  deletePreset: "Delete preset",
  presetName: "Preset name",
  presetFull: "5 presets saved (full)",
  bgPrimary: "Background",
  bgSecondary: "Secondary BG",
  bgSidebar: "Sidebar",
  textPrimary: "Text",
  accentColor: "Accent",
  language: "Language",
  chinese: "中文",
  english: "English",
  personal: "Personal",
  personalSignInTitle: "Sign in to manage your profile",
  personalSignInHint: "Sign in to sync your nickname and avatar, and use cloud workspaces across devices.",
  personalOpenSignIn: "Sign in / Create account",
  personalSignedIn: "Signed in",
  personalProfile: "Profile",
  personalNickname: "Nickname",
  personalNicknamePlaceholder: "Choose a nickname people will remember",
  personalChangeNickname: "Change nickname",
  personalSaveNickname: "Save nickname",
  personalChangeAvatar: "Change avatar",
  personalAvatarHint: "JPG, PNG, or WebP. Drag, zoom, and crop after choosing an image.",
  avatarCropTitle: "Edit avatar",
  avatarCropHint: "Drag to reposition, then zoom until the content you want fits inside the circle.",
  avatarCropDragHint: "Drag to reposition",
  avatarCropZoom: "Avatar zoom",
  avatarCropZoomIn: "Zoom in",
  avatarCropZoomOut: "Zoom out",
  avatarCropCancel: "Cancel",
  avatarCropConfirm: "Use this avatar",
  avatarCropLoadFailed: "This image could not be opened. Choose a JPG, PNG, or WebP file.",
  avatarHistory: "Avatar History",
  useHistoryAvatar: "Use this avatar",
  useHistoryBackground: "Use this background",
  deleteHistoryImage: "Delete history image",
  personalSecurity: "Account security",
  personalChangePassword: "Change password",
  personalNewPassword: "New password",
  personalConfirmPassword: "Confirm new password",
  personalPasswordUpdated: "Password updated",
  personalPasswordMismatch: "The new passwords do not match",
  personalProfileUpdated: "Nickname updated",
  personalAvatarUpdated: "Avatar updated",
  personalSignOutHint: "You can keep using local notes after signing out. Cloud workspaces require signing in again.",
  personalDataHint: "Your profile is stored securely with your account and is used only for identity and sync display.",
  personalNotConfigured: "Sign-in is not configured yet. Finish the Supabase setup first.",
  personalSaving: "Saving...",
  personalChooseImage: "Choose image",
  close: "Close",
  defaultFont: "Default Font",
  importFont: "Import Font",
  exportFile: "Export File",
  exportFilterMarkdown: "Markdown File",
  exportFilterText: "Plain Text File",
  exportFilterWord: "Word Document",
  exportFilterPdf: "PDF Document",
  exportImagesDropped: "{count} image(s) could not be embedded and were skipped.",
  exportFailed: "Export failed: {message}",
  collapseSidebar: "Collapse",
  expandSidebar: "Expand",
  enableAlwaysOnTop: "Keep window on top",
  disableAlwaysOnTop: "Stop keeping window on top",
  saved: "Saved",
  unsaved: "Unsaved",
  save: "Save",
  undo: "Undo",
  redo: "Redo",
  insertTable: "Insert table (Ctrl+Alt+T)",
  insertImage: "Insert image",
  insertImageFailed: "Could not insert the image: {message}",
  about: "About",
  aboutTitle: "About Qing Notepad",
  version: "Version",
  author: "Author",
  sourceCode: "Source Code",
  personalBlog: "Personal Blog",
  qqDiscussionGroup: "QQ Discussion Group",
  copyQqGroupNumber: "Copy QQ group number",
  friendSponsor: "Friend Sponsor",
  minimize: "Minimize",
  maximize: "Maximize",
  restore: "Restore",
  wordCount: "{count} words",
  showWindow: "Show Window",
  quitApp: "Quit Application",
  hideToTray: "Minimize to Tray",
  shortcutsSection: "Keyboard Shortcuts",
  autoSaveSection: "Auto Save",
  autoSaveOff: "Off",
  autoSave10s: "10 seconds",
  autoSave30s: "30 seconds",
  autoSave1m: "1 minute",
  stickyOpacity: "Sticky Opacity",
  dataLocation: "Data Location",
  openDataFolder: "Open Folder",
  imageCache: "Image Cache",
  openImageCache: "Open Folder",
  trash: "Recycle Bin",
  trashRetention: "Keep Deleted Notes For",
  trashRetentionDisabled: "Off",
  trashRetention7Days: "7 days",
  trashRetention30Days: "30 days",
  trashRetention90Days: "90 days",
  trashRetentionForever: "Forever",
  trashHint: "Deleted notes go to the recycle bin and expire automatically",
  trashEmpty: "Recycle bin is empty",
  trashEmptyHint: "Deleted notes show up here and can be restored within the retention period.",
  trashRestore: "Restore",
  trashDeleteForever: "Delete permanently",
  trashDeletedAt: "Deleted {time}",
  trashOriginalCategory: "Category: {category}",
  trashRemaining: "{days} days left",
  trashRemainingLessThanDay: "Less than a day left",
  trashExpiresNever: "Never expires",
  trashRestored: "Restored \"{note}\"",
  trashRestoreMissingImages: "{count} image(s) are no longer available",
  trashRestoreFailed: "Restore failed, please try again",
  trashConfirmDeleteMessage: "\"{note}\" will be deleted permanently. This cannot be undone.",
  trashClearAll: "Empty recycle bin",
  trashConfirmClearMessage: "{count} note(s) will be deleted permanently. This cannot be undone.",
  trashDisabled: "Recycle bin is off",
  trashDisabledHint: "Notes deleted while it is off cannot be restored. You can turn it back on in settings.",
  trashOpenSettings: "Open settings",
  trashLoading: "Loading…",
  moveNoteToTrash: "Move to Recycle Bin",
  confirmMoveToTrashMessage: "\"{note}\" will be moved to the recycle bin and can be restored. Retention: {days}.",
  shortcutToggleWindow: "Show/Hide Window",
  shortcutPinSticky: "Pin Sticky Note",
  resetShortcuts: "Reset to Default",
  pressShortcut: "Press shortcut...",
  pinSticky: "Pin as Sticky",
  unpinSticky: "Unpin",
  stickyNote: "Sticky Note",
  stickyEmptyHint: "Double-click to start writing…",
  pinNote: "Pin Note",
  unpinNote: "Unpin Note",
  tileNoNote: "No note selected",
  checkUpdate: "Check for Updates",
  checkingUpdate: "Checking...",
  upToDate: "Up to date",
  newVersion: "New version v{version}",
  downloadUpdate: "Download Update",
  checkUpdateFailed: "Update check failed",
  updateAvailableTitle: "Update available",
  updateAvailableMessage: "Qing Notepad v{version} is available. Update now?",
  currentVersion: "Current version",
  latestVersion: "Latest version",
  updateNow: "Update now",
  updateLater: "Later",
  neverRemind: "Don't remind again",
  aiAssistant: "XiaoQing",
  aiSettings: "AI Settings",
  aiApiKey: "DeepSeek API Key",
  aiApiKeyPlaceholder: "sk-...",
  aiApiKeyHint: "Create one at platform.deepseek.com. Stored locally, encrypted.",
  aiSaveKey: "Save",
  aiClearKey: "Clear",
  aiVerifyKey: "Test connection",
  aiKeySaved: "API key saved",
  aiKeyCleared: "API key cleared",
  aiKeyMissing: "No API key configured",
  aiVerifySuccess: "Connection OK",
  aiPrivacyNoticeTitle: "Privacy notice",
  aiPrivacyNoticeBody:
    "When you use AI features, the passage you select, retrieved note excerpts and your questions are sent to DeepSeek to generate replies. With web search enabled, your question is also sent to DeepSeek's search service. Knowledge base search runs locally. Your API key is encrypted by the system and stored on this machine only.",
  aiPrivacyAgree: "Got it",
  aiErrorUnauthorized: "Invalid API key. Check it and try again.",
  aiErrorBalance: "Insufficient account balance",
  aiErrorRateLimit: "Too many requests. Try again later.",
  aiErrorNetwork: "Network request failed. Check your connection.",
  aiErrorServer: "DeepSeek service is temporarily unavailable",
  aiErrorBadResponse: "Unexpected response. Please retry.",
  aiErrorMissingKey: "Configure an API key first",
  aiErrorAborted: "Generation stopped",
  aiSidebarHint: "I'm XiaoQing. Ask anything about using Qing Notepad. Answers come from the built-in user manual.",
  aiInputPlaceholder: "e.g. How do I export a note to PDF?",
  aiSend: "Send",
  aiStop: "Stop",
  aiClearChat: "Clear chat",
  aiThinking: "Thinking…",
  aiPhaseRetrieving: "Searching the local knowledge base…",
  aiPhaseWriting: "Working on the note…",
  aiTruncated: "The answer hit the length limit and may be cut off.",
  aiViewDiff: "View changes",
  aiDiffTooLong: "Content is long — showing the first 400 lines only.",
  aiDiffUnavailable: "The original version is no longer available.",
  aiReasoning: "Reasoning",
  aiNoResult: "Nothing relevant in the manual. Try rephrasing.",
  aiNoKeyHint: "No API key configured — XiaoQing answers offline with streamed retrieval results. Add your DeepSeek key in Settings → AI Settings for generated answers.",
  aiModelLabel: "Chat model",
  aiModelLocal: "XiaoQing",
  aiModelLocalSub: "Local retrieval, offline",
  aiModelSection: "Model",
  aiModelAdd: "Manage endpoints and models",
  aiModelNoEndpoint:
    "No model available yet. Add an endpoint in Settings → AI Settings and tick the models you want.",
  aiThinkingTitle: "Reasoning effort",
  aiThinkingOff: "Off",
  aiThinkingLow: "Low",
  aiThinkingHigh: "High",
  aiThinkingEffectOff: "Send no thinking fields",
  aiThinkingEffectLow: "Low reasoning effort",
  aiThinkingEffectHigh: "High reasoning effort",
  aiEndpointTitle: "API endpoints",
  aiEndpointHint: "Your own base URL and key — whatever you configure is what runs",
  aiEndpointEmpty:
    "No endpoint configured. Add one below: pick a common service to pre-fill the address, then paste your key.",
  aiEndpointUntitled: "Untitled endpoint",
  aiEndpointNoUrl: "No address yet",
  aiEndpointModelCount: "{on}/{total} models",
  aiEndpointName: "Name",
  aiEndpointNamePlaceholder: "e.g. Kimi",
  aiEndpointBaseUrl: "Base URL",
  aiEndpointKey: "API key",
  aiEndpointKeySet: "Saved — type a new value to replace it",
  aiEndpointKeyPlaceholder: "sk-...",
  aiEndpointModels: "Models",
  aiEndpointSearch: "Search models",
  aiEndpointSearching: "Searching…",
  aiEndpointNoModels: 'No models yet. Fill in the URL and key, then press "Search models".',
  aiEndpointThinkingHint:
    "Whether this model supports deep thinking (no thinking fields are sent when off)",
  aiEndpointModelsHint: "Only ticked models appear in the chat bar's model list.",
  aiEndpointDelete: "Delete endpoint",
  aiEndpointDeleteConfirm: "Confirm delete",
  aiEndpointDeleteSessions: "{count} chat(s) will be deleted with it. This cannot be undone.",
  aiEndpointCancel: "Cancel",
  aiEndpointAdd: "Add endpoint",
  aiEndpointCustom: "Custom",
  aiActPolish: "Polish",
  aiActRewrite: "Rewrite",
  aiActContinue: "Continue",
  aiActSummarize: "Summarize",
  aiActTranslate: "Translate",
  aiActChecklist: "To-do list",
  aiActCardHint: "Read-only result — the passage is never overwritten",
  aiCardTitle: "Result",
  aiCardCopy: "Copy",
  aiCardCopied: "Copied",
  aiCardPoints: "Key points",
  aiCardTags: "Tags",
  aiSmallTalkGreeting:
    "Hi, I'm XiaoQing, an offline retrieval model — I can't chat. But ask me anything about using Qing Notepad and I'll dig it out of the manual.",
  aiSmallTalkIdentity:
    "I'm XiaoQing, Qing Notepad's built-in offline retrieval model. I don't chat and I don't generate text, but I can search the built-in manual, your notes, todos and canvas content locally to answer questions about the app.",
  panelCrashTitle: "This panel failed to render",
  panelCrashBody:
    "Something threw while rendering. The rest of the app is unaffected — retry, or restart the app.",
  panelCrashRetry: "Retry",
  aiPolishModelLabel: "Polish model",
  aiAnswerSteps: "Steps",
  aiAnswerHowto: "Do this",
  aiAnswerWhere: "Where to find it",
  aiAnswerWhereAlt: "Location",
  aiAnswerVerdict: "Short answer",
  aiAnswerExplain: "Overview",
  aiAnswerExcerpt: "From the manual",
  aiExampleQ1: "How do I export a note to PDF?",
  aiExampleQ2: "Where does the app go when I close the window?",
  aiExampleQ3: "How do I back up my notes?",
  aiExampleQ4: "How do I export a note to Word?",
  aiExampleQ5: "Can I organize notes with tags?",
  aiExampleQ6: "How do I open several notes at once?",
  aiExampleQ7: "Can I recover a deleted note?",
  aiExampleQ8: "What's the difference between sticky notes and tiles?",
  aiExampleQ9: "How do I customize the global shortcut?",
  aiExampleQ10: "How do I switch to the dark theme?",
  aiExampleQ11: "How do I move my notes to a new computer?",
  aiExampleQ12: "Can todos have priorities?",
  aiShuffleExamples: "Shuffle",
  aiClose: "Close",
  aiCopy: "Copy",
  aiCopied: "Copied",
  aiRegenerate: "Regenerate",
  aiDeleteMessage: "Delete this exchange",
  aiClearConfirmTitle: "Clear the chat?",
  aiClearConfirmBody: "All current questions and answers will be removed. This cannot be undone.",
  aiClearConfirmOk: "Clear",
  aiCancel: "Cancel",
  aiGreeting: "Hi, I'm XiaoQing. Ask me anything about using Qing Notepad.",
  aiEmptyGreetingApi:
    "Answering with {model} on {channel}. Ask about using Qing Notepad, or have me read your notes.",
  aiEmptyGreetingModel:
    "Answering with {model}. Ask about using Qing Notepad, or have me read your notes.",
  aiEmptyGreetingNoKey: "{channel} has no API key yet. Add one in Settings → AI to start chatting.",
  aiStatusReady: "Connected",
  aiStatusNoKey: "No key",
  aiNewChat: "New chat",
  aiHistory: "History",
  aiRename: "Rename",
  aiDeleteConversation: "Delete conversation",
  aiDeleteConversationTitle: "Delete this conversation?",
  aiDeleteConversationBody: "All messages in this conversation will be removed. This cannot be undone.",
  aiNoConversations: "No conversations yet",
  aiUntitled: "Untitled chat",
  aiPolishTitle: "AI Polish",
  aiPolishEntry: "Polish selection with AI",
  aiPolishNoSelection: "Select some text in the editor first",
  aiPolishPlaceholder: "Optional: extra instruction, e.g. \"make it more formal\"",
  aiPolishGenerate: "Generate rewrite",
  aiPolishApply: "Apply to note",
  aiPolishUndo: "Undo this change",
  aiPolishApplied: "Applied to note",
  aiPolishBack: "Back to chat",
  aiPolishStylePolish: "Polish",
  aiPolishStyleConcise: "More concise",
  aiPolishStyleFormal: "More formal",
  aiPolishStyleCasual: "More casual",
  aiDiffBefore: "Before",
  aiDiffAfter: "After",
  aiPolishStale: "The note changed. Select again and retry.",
  aiPermLabel: "Note edit permission",
  aiPermReadOnly: "Assistant only",
  aiPermFull: "Full access",
  aiPermLocalOnly: "XiaoQing is a read-only local search; switch to an API model to enable note editing",
  aiPermConfirmTitle: "Enable full note access?",
  aiPermConfirmBody: "The AI can directly edit note bodies and titles; changes apply immediately. Every edit keeps a snapshot and can be undone from its message.",
  aiPermConfirmOk: "Enable",
  aiEditApplied: "Edited note",
  aiUndoEdit: "Undo this edit",
  aiEditUndone: "Undone",
  helpMenu: "Help",
  helpManual: "User Manual",
  helpFaq: "FAQ",
  helpShortcuts: "Keyboard Shortcuts",
  helpReportIssue: "Report an Issue",
  helpShortcutsNote: "These shortcuts are fixed and cannot be customised (except show/hide window).",
  shortcutGroupGlobal: "Global",
  shortcutGroupNote: "Note editing",
  shortcutGroupTabs: "Tabs",
  shortcutGroupCanvas: "Canvas",
  shortcutSaveNote: "Save current note",
  shortcutCloseTab: "Close current tab",
  shortcutInsertTable: "Insert table",
  shortcutUndoRedo: "Undo / redo",
  retry: "Retry",
  quitConfirmTitle: "Quit Qing Notepad?",
  quitConfirmMessage: "All sticky and tile windows will close. Unsaved edits are written to disk first.",
  updateCheckErrorDetail: "Reason: {detail}",
  importFailed: "Import failed: {message}",
  loading: "Loading…",
  authSignedOut: "Not signed in",
  pluginsTitle: "Extensions",
  pluginsSearchPlaceholder: "Search extensions",
  pluginsInstalledSection: "Installed",
  pluginsAvailableSection: "Available",
  pluginsEmptyInstalled: "No extensions installed yet",
  pluginsEmptyAvailable: "No extensions available",
  pluginsOfflineHint: "Offline — this list may be out of date",
  pluginsIndexLoading: "Fetching the extension index…",
  pluginsInstallFromFile: "Install from file",
  pluginsInstallFromFolder: "Install from folder",
  pluginsRefreshIndex: "Refresh index",
  pluginsOnline: "Online",
  pluginsOffline: "Offline",
  pluginsSelectHint: "No extension selected",
  pluginsSelectHintBody: "Pick an extension on the left to see its details. Extensions can only add commands; they cannot change the interface.",
  pluginsSidebarFooterHint: "Extension code runs in a separate worker with no network access.",
  pluginVersion: "Version",
  pluginAuthor: "Author",
  pluginRepository: "Repository",
  pluginLicense: "License",
  pluginPermissions: "Permissions",
  pluginPermissionsNone: "No permissions required",
  pluginCommands: "Commands",
  pluginNoCommands: "Provides no commands",
  pluginInstall: "Install",
  pluginUpdate: "Update",
  pluginUninstall: "Uninstall",
  pluginUninstallTitle: "Uninstall {name}?",
  pluginUninstallBody: "The extension files will be deleted. Keeping its settings means a reinstall can pick up where it left off.",
  pluginUninstallKeep: "Keep settings and uninstall",
  pluginUninstallDrop: "Delete everything",
  pluginRollback: "Roll back",
  pluginEnable: "Enable",
  pluginDisable: "Disable",
  pluginEnabled: "Enabled",
  pluginDisabled: "Disabled",
  pluginRunning: "Running",
  pluginNotRunning: "Not running",
  pluginSourceIndex: "From the extension index",
  pluginSource: "Source",
  pluginInfo: "Details",
  pluginSourceFile: "Installed from a file",
  pluginViewLog: "Error log",
  pluginLogEmpty: "No errors logged",
  pluginLogTitle: "Error log (last 100 entries)",
  pluginUpdateAvailable: "Update available",
  pluginPermissionRevoke: "Revoke",
  pluginPermissionNew: "New",
  pluginPermissionGrant: "Grant",
  pluginLockedNote: "Once revoked, the extension's calls to that capability are refused.",
  pluginPermPromptInstallTitle: "Install {name}?",
  pluginPermPromptUpdateTitle: "Update {name}?",
  pluginPermPromptBody: "This extension will be granted:",
  pluginPermPromptAddedBody: "The new version asks for these additional permissions:",
  pluginPermPromptApprove: "Allow and install",
  pluginPermPromptUpdate: "Allow and update",
  pluginPermPromptCancel: "Cancel",
  pluginPermStorage: "Save this extension's settings",
  pluginPermNotesRead: "Read your notes",
  pluginPermNotesWrite: "Modify your notes",
  pluginPermTodoRead: "Read your todos",
  pluginPermTodoWrite: "Modify your todos",
  pluginPermClipboardRead: "Read the clipboard",
  pluginPermClipboardWrite: "Write to the clipboard",
  pluginPermNotify: "Show notifications",
  pluginPermEditorRead: "Read the note you have open",
  pluginPermEditorWrite: "Change the note you have open",
  pluginPermEditorDecorate: "Mark up the note you have open",
  pluginPermViews: "Add a panel to the sidebar",
  pluginPermEditorSelection: "Move your cursor and scroll position",
  pluginCrashedDisabled: "{name} crashed repeatedly and was disabled",
  pluginPermissionDenied: "The extension lacks permission: {permission}",
  pluginInstalled: "Installed {name}",
  pluginUpdated: "Updated {name}",
  pluginUninstalled: "Uninstalled {name}",
  pluginRolledBack: "Rolled back to {version}",
  pluginCommandFailed: "Command failed: {code}",
  pluginInstallFailed: "Install failed: {message}",
  pluginHostIncompatible: "This extension does not support the current app version",
  pluginApiIncompatible: "This extension's API version is not supported",
  pluginCommandConflict: "Command IDs already taken: {ids}",
  pluginNativeModule: "The package contains a native module and cannot be installed",
  pluginPackageTooLarge: "The package exceeds the 20 MB limit",
  pluginManifestMissing: "No manifest in the package: the root needs package.json (with a main entry) or plugin.json",
  pluginManifestInvalid: "The extension manifest is invalid: {detail}",
  pluginMissingMain: "The entry point named by the manifest is not in the package: {detail}",
  pluginTooManyFiles: "The package has more than 2000 files",
  pluginPermissionUnknown: "The manifest declares a permission this app does not know: {detail}",
  pluginEntryNameInvalid: "The package contains an invalid file name; it may be a disguised archive",
  pluginIndexPermissionMismatch: "The permissions listed in the index do not match the package; the install was refused: {detail}",
  commandPaletteTitle: "Command palette",
  commandPalettePlaceholder: "Type a command…",
  commandPaletteEmpty: "No matching commands",
  commandPaletteHint: "↑↓ to move · Enter to run · Esc to close",
  commandCategoryView: "View",
  commandCategoryNote: "Note",
  commandCategoryApp: "App",
  commandCategoryPlugin: "Extension",
  commandNewNote: "New note",
  commandOpenSettings: "Open settings",
  commandToggleAi: "Toggle AI assistant",
  settingsPlugins: "Extensions",
  pluginsSettingsOpen: "Open the extensions page",
  pluginsSettingsOpenHint: "Installing, enabling, uninstalling and permissions all live on the extensions page.",
  pluginsDisableAll: "Disable all plugins",
  pluginsDisableAllHint: "Temporarily stops every extension. Installed files are kept.",
};

const translations: Record<LangType, TranslationKeys> = { zh, en };

export function t(lang: LangType, key: keyof TranslationKeys): string {
  return translations[lang][key];
}

export function tWithParams(
  lang: LangType,
  key: keyof TranslationKeys,
  params: Record<string, string | number>,
): string {
  let result = translations[lang][key];
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(`{${k}}`, String(v));
  }
  return result;
}
