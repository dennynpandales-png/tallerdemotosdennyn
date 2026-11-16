; Script generado para HIDEP-SOFT por el Asistente de Inno Setup
#define MyAppName "HIDEP-SOFT"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Dennyn Pandales - Taller de Motos"
#define MyAppExeName "HIDEP-SOFT.exe"

[Setup]
; Identificador único de tu aplicación
AppId={{C2F9B8A1-4E82-41A3-B69F-123456789ABC}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
; Carpeta donde se guardará el instalador final (.exe) resultante
OutputDir=.\dist_inno
OutputBaseFilename=HIDEP-SOFT-Setup-1.0.0
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile=public\icon.ico

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; IMPORTANTE: Apunta a la carpeta donde electron-builder genera los archivos empaquetados sin instalador (ej. carpeta 'win-unpacked')
Source: "dist\win-unpacked\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent