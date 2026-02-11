/**
 * @description Convert VobSub subtitle files (.idx/.sub) to SRT format using vobsub2srt and optionally mux into MKV.
 * @param {bool} DumpImages Pass --dump-images to vobsub2srt (default: false).
 * @param {(''|'en'|'eng'|'fr'|'fre'|'de'|'ger'|'es'|'spa'|'it'|'ita'|'ja'|'jpn'|'ko'|'kor'|'zh'|'chi'|'ru'|'rus'|'pt'|'por'|'nl'|'dut'|'sv'|'swe'|'da'|'dan'|'no'|'nor'|'fi'|'fin')} TrackLanguageFilter Language code(s) to filter VobSub tracks from MKV (e.g. "eng", "fre,ger"). Default "eng". Leave empty to consider all VobSub tracks.
 * @param {(''|'en'|'eng'|'fr'|'fre'|'de'|'ger'|'es'|'spa'|'it'|'ita'|'ja'|'jpn'|'ko'|'kor'|'zh'|'chi'|'ru'|'rus'|'pt'|'por'|'nl'|'dut'|'sv'|'swe'|'da'|'dan'|'no'|'nor'|'fi'|'fin')} VobSubStreamLanguage Language code for vobsub2srt --lang (selects stream within VobSub pair). If empty, uses MKV track's language. (e.g., "en", "de", default: empty).
 * @param {(''|'en'|'eng'|'fr'|'fre'|'de'|'ger'|'es'|'spa'|'it'|'ita'|'ja'|'jpn'|'ko'|'kor'|'zh'|'chi'|'ru'|'rus'|'pt'|'por'|'nl'|'dut'|'sv'|'swe'|'da'|'dan'|'no'|'nor'|'fi'|'fin')} TesseractOcrLanguage Language for vobsub2srt --tesseract-lang. If empty, uses VobSubStreamLanguage or MKV track language, falling back to "eng". (default: empty).
 * @param {string} Blacklist Character blacklist for vobsub2srt --blacklist (e.g. "|\/_~<>", default: empty).
 * @param {int} YThreshold Y threshold for vobsub2srt --y-threshold (default: 0).
 * @param {int} MinWidth Minimum width for vobsub2srt --min-width (default: 9).
 * @param {int} MinHeight Minimum height for vobsub2srt --min-height (default: 1).
 * @param {bool} MuxToMkv If true and input is MKV, muxes created SRTs back into a new MKV file. If false, SRTs are saved externally. (default: true)
 * @param {bool} SkipIfNoSubtitles Skip processing if no applicable VobSub tracks found (default: true)
 * @param {('0644'|'0666'|'0755'|'0777')} FilePermissions Permissions for external SRT files (default: "0666").
 * @param {int} FileWaitMs Time to wait for file operations in milliseconds (default: 2000)
 * @output 1 Subtitles processed: SRTs created and either muxed or saved externally, or skipped successfully.
 * @output -1 Processing failed, or no SRTs were successfully generated from eligible tracks that were attempted.
 */
function Script(DumpImages, TrackLanguageFilter, VobSubStreamLanguage, TesseractOcrLanguage, Blacklist, YThreshold, MinWidth, MinHeight, MuxToMkv, SkipIfNoSubtitles, FilePermissions, FileWaitMs) {

    function safeString(param, defaultValue = "") {
        if (param === undefined || param === null) {
            return defaultValue;
        }
        return String(param);
    }

    // Parameter Initialization
    DumpImages = DumpImages === true;
    // TrackLanguageFilter: Default "eng". Empty string from UI means process all.
    if (TrackLanguageFilter === undefined || TrackLanguageFilter === null) {
        TrackLanguageFilter = "eng"; // Default if parameter not provided by flow
    } else {
        TrackLanguageFilter = String(TrackLanguageFilter); // Ensure it's a string
    }

    VobSubStreamLanguage = safeString(VobSubStreamLanguage, "");
    TesseractOcrLanguage = safeString(TesseractOcrLanguage, "");
    Blacklist = safeString(Blacklist, "");
    YThreshold = YThreshold === undefined ? 0 : parseInt(YThreshold, 10);
    MinWidth = MinWidth === undefined ? 9 : parseInt(MinWidth, 10);
    MinHeight = MinHeight === undefined ? 1 : parseInt(MinHeight, 10);
    MuxToMkv = MuxToMkv === undefined ? true : MuxToMkv !== false;
    SkipIfNoSubtitles = SkipIfNoSubtitles !== false;
    FilePermissions = FilePermissions || "0666";
    FileWaitMs = FileWaitMs || 2000;

    // Use full paths for all executables
    const VOBSUB2SRT_EXECUTABLE = "/opt/vobsub2srt/vobsub2srt";
    const MKVMERGE_EXECUTABLE = "/usr/bin/mkvmerge";
    const MKVEXTRACT_EXECUTABLE = "/usr/bin/mkvextract";

    let workingFile = Flow.WorkingFile;
    let originalFileNameForOutput = Flow.OriginalFile;
    if (!originalFileNameForOutput) {
        Logger.WLog("Flow.OriginalFile is undefined. Falling back to Flow.WorkingFile for output path base.");
        originalFileNameForOutput = Flow.WorkingFile;
    }
    let fileExt = workingFile.substring(workingFile.lastIndexOf('.') + 1).toLowerCase();

    Logger.ILog("=== VOBSUB TO SRT CONVERTER SCRIPT (FIXED) ===");
    Logger.ILog(`Working File (temp): ${workingFile}`);
    Logger.ILog(`Original File (for output ref): ${originalFileNameForOutput}`);
    if (MuxToMkv && fileExt === "mkv") Logger.ILog("MUX TO MKV ENABLED for MKV input.");

    // Log effective filter/language parameters
    Logger.ILog(`MKV Track Language Filter set to: "${TrackLanguageFilter}" (empty means all tracks considered after mkvmerge scan)`);
    Logger.ILog(`VobSub Internal Stream Language Selector (--lang) set to: "${VobSubStreamLanguage}" (empty means auto/first)`);
    Logger.ILog(`Tesseract OCR Language Override (--tesseract-lang) set to: "${TesseractOcrLanguage}" (empty means derived or tool default)`);

    // Test if mkvmerge is available
    try {
        let testResult = Flow.Execute({
            command: MKVMERGE_EXECUTABLE,
            argumentList: ["--version"]
        });
        Logger.ILog(`mkvmerge version check: Exit code ${testResult.exitCode}`);
        if (testResult.exitCode !== 0) {
            Logger.ELog("mkvmerge command not found or not accessible. Please ensure mkvtoolnix is installed.");
            return -1;
        }
    } catch (e) {
        Logger.ELog(`Failed to execute mkvmerge version check: ${e.message || e}`);
        return -1;
    }

    const mkvTrackLangFilterArray = TrackLanguageFilter.trim() ? // An empty string for TrackLanguageFilter now correctly means "process all"
        TrackLanguageFilter.toLowerCase().split(',').map(l => l.trim()).filter(l => l) :
        [];

    if (mkvTrackLangFilterArray.length > 0) {
        Logger.ILog(`Filtering MKV VobSub tracks for languages: ${mkvTrackLangFilterArray.join(', ')}`);
    } else {
        Logger.ILog("No MKV Track Language Filter specified (or was empty): all VobSub tracks will be considered.");
    }

    if (fileExt === "mkv") {
        return processMkvFile();
    } else if (fileExt === "idx") {
        if (MuxToMkv) Logger.ILog("Note: MuxToMkv is true, but input is a standalone IDX. Output will be an external SRT.");
        return processIdxFile(workingFile, originalFileNameForOutput);
    } else {
        Logger.WLog(`Unsupported file type: '${fileExt}'. Supported: MKV, IDX.`);
        return SkipIfNoSubtitles ? 1 : -1;
    }

    function processMkvFile() {
        Logger.ILog("MKV file detected. Identifying VobSub tracks...");

        let mkvMergeIdResult;
        try {
            mkvMergeIdResult = Flow.Execute({
                command: MKVMERGE_EXECUTABLE,
                argumentList: ["-i", "-F", "json", workingFile]
            });
        } catch (e) {
            Logger.ELog(`Failed to execute mkvmerge: ${e.message || e}`);
            return -1;
        }

        if (!mkvMergeIdResult) {
            Logger.ELog("mkvmerge execution returned null result");
            return -1;
        }

        if (mkvMergeIdResult.exitCode !== 0) {
            Logger.ELog(`Failed to get track info (mkvmerge). Exit: ${mkvMergeIdResult.exitCode}`);
            Logger.ELog(`Stdout: ${mkvMergeIdResult.output || 'No output'}`);
            Logger.ELog(`Stderr: ${mkvMergeIdResult.standardError || 'No error output'}`);
            return -1;
        }

        let tracksInfoJson;
        try {
            // First, try to clean up any potential issues in the JSON
            let jsonOutput = mkvMergeIdResult.output;

            // Log the first 1000 characters of the JSON for debugging
            Logger.ILog(`First 1000 chars of JSON output: ${jsonOutput.substring(0, 1000)}`);

            // If the JSON appears truncated (doesn't end with }), try to find complete JSON
            if (!jsonOutput.trim().endsWith('}')) {
                Logger.WLog("JSON output appears truncated. Attempting to extract complete JSON...");

                // Try an alternative approach - use mkvmerge without -F json flag
                let altResult = Flow.Execute({
                    command: MKVMERGE_EXECUTABLE,
                    argumentList: ["-i", workingFile]
                });

                if (altResult.exitCode === 0) {
                    Logger.ILog("Using alternative track detection method...");
                    return processMkvFileAlternative(altResult.output);
                }
            }

            tracksInfoJson = JSON.parse(jsonOutput);
        } catch (e) {
            Logger.ELog(`Failed to parse mkvmerge JSON: ${e.message}.`);
            Logger.ILog("Attempting alternative track detection method...");

            // Try alternative method
            let altResult = Flow.Execute({
                command: MKVMERGE_EXECUTABLE,
                argumentList: ["-i", workingFile]
            });

            if (altResult.exitCode === 0) {
                return processMkvFileAlternative(altResult.output);
            } else {
                Logger.ELog("Alternative method also failed");
                return -1;
            }
        }

        let vobSubTracksFound = [];
        if (tracksInfoJson && tracksInfoJson.tracks) {
            tracksInfoJson.tracks.forEach(track => {
                if (track.type === "subtitles" && (track.codec === "VobSub" || track.codec_id === "S_VOBSUB")) {
                    let trackId = track.id;
                    let trackName = track.properties && track.properties.track_name ? track.properties.track_name : 'Untitled VobSub Track';
                    let lang = track.properties && track.properties.language ? track.properties.language.toLowerCase() : "und";
                    let langIETF = track.properties ? (track.properties.language_ietf || track.properties.language || 'N/A') : 'N/A';
                    Logger.ILog(`Discovered VobSub Track ID ${trackId} (Name: "${trackName}", Codec: ${track.codec}) - Language: "${lang}" (Original Tag: ${langIETF})`);
                    vobSubTracksFound.push({ id: trackId.toString(), language: lang, originalLanguageTag: langIETF, trackName: trackName });
                }
            });
        }

        if (vobSubTracksFound.length === 0) {
            Logger.WLog("No VobSub tracks found in the MKV.");
            return SkipIfNoSubtitles ? 1 : -1;
        }

        // Continue with the rest of the processing...
        return continueProcessingVobSubTracks(vobSubTracksFound);
    }

    function processMkvFileAlternative(mkvmergeOutput) {
        Logger.ILog("Using alternative parsing method for mkvmerge output...");

        let vobSubTracksFound = [];
        let lines = mkvmergeOutput.split('\n');

        for (let line of lines) {
            // Look for subtitle tracks with VobSub codec
            // Format: Track ID X: subtitles (VobSub)
            let subtitleMatch = line.match(/Track ID (\d+): subtitles \(VobSub\)/);
            if (subtitleMatch) {
                let trackId = subtitleMatch[1];
                let lang = "und";
                let trackName = "Untitled VobSub Track";

                // Try to extract language if present
                let langMatch = line.match(/language:(\w+)/);
                if (langMatch) {
                    lang = langMatch[1].toLowerCase();
                }

                // Try to extract track name if present
                let nameMatch = line.match(/track_name:([^']+)/);
                if (nameMatch) {
                    trackName = nameMatch[1].trim();
                }

                Logger.ILog(`Found VobSub Track ID ${trackId} (Name: "${trackName}") - Language: "${lang}"`);
                vobSubTracksFound.push({
                    id: trackId,
                    language: lang,
                    originalLanguageTag: lang,
                    trackName: trackName
                });
            }
        }

        if (vobSubTracksFound.length === 0) {
            Logger.WLog("No VobSub tracks found in the MKV using alternative method.");
            return SkipIfNoSubtitles ? 1 : -1;
        }

        return continueProcessingVobSubTracks(vobSubTracksFound);
    }

    function continueProcessingVobSubTracks(vobSubTracksFound) {
        Logger.ILog(`Found ${vobSubTracksFound.length} raw VobSub tracks. Applying MKV Track Language filter...`);
        let currentFilteredTracks = vobSubTracksFound;

        if (mkvTrackLangFilterArray.length > 0) {
            const countBefore = currentFilteredTracks.length;
            currentFilteredTracks = currentFilteredTracks.filter(track => {
                let trackLangSimple = track.language.substring(0, 2);
                // If filter is active, track must match.
                return mkvTrackLangFilterArray.includes(track.language) || mkvTrackLangFilterArray.includes(trackLangSimple);
            });
            Logger.ILog(`Tracks after MKV Track Language filter ('${TrackLanguageFilter}'): ${currentFilteredTracks.length} (was ${countBefore}).`);
        }

        let finalFilteredTracks = currentFilteredTracks;
        if (finalFilteredTracks.length === 0) {
            Logger.WLog("No VobSub tracks remain after filtering.");
            return SkipIfNoSubtitles ? 1 : -1;
        }

        Logger.ILog(`Attempting to process ${finalFilteredTracks.length} VobSub tracks.`);
        // FIX: Replace dots with underscores in the base name to work around mkvextract bug #1140.
        // mkvextract splits VobSub output filenames at the FIRST dot, so dots in the basename
        // cause the .idx/.sub files to be created with truncated names.
        let baseNameForTempFiles = workingFile
            .substring(workingFile.lastIndexOf(Flow.IsWindows ? '\\' : '/') + 1, workingFile.lastIndexOf('.'))
            .replace(/\./g, '_');
        let srtFilesDataForProcessing = [];

        for (let i = 0; i < finalFilteredTracks.length; i++) {
            let track = finalFilteredTracks[i];
            let extractBaseName = `${Flow.TempPath}/${baseNameForTempFiles}_${track.id}_${i}`;
            let vobSubBasePathInTemp = extractBaseName;
            let idxFilePath = `${extractBaseName}.idx`;
            let subFilePath = `${extractBaseName}.sub`;

            Logger.ILog(`Processing VobSub Track ID ${track.id} (Name: "${track.trackName}", MKV Lang: ${track.language}, Index: ${i}). Extracting to: ${idxFilePath}`);

            let extractResult;
            try {
                extractResult = Flow.Execute({
                    command: MKVEXTRACT_EXECUTABLE,
                    argumentList: ["tracks", workingFile, `${track.id}:${extractBaseName}`]
                });
            } catch (e) {
                Logger.ELog(`Failed to execute mkvextract for track ${track.id}: ${e.message || e}`);
                continue;
            }

            if (extractResult.exitCode !== 0) {
                Logger.ELog(`mkvextract failed for VobSub track ${track.id}. Exit: ${extractResult.exitCode}. Stderr: ${extractResult.standardError || 'N/A'}`);
                continue;
            }
            System.Threading.Thread.Sleep(FileWaitMs);
            if (!System.IO.File.Exists(idxFilePath) || !System.IO.File.Exists(subFilePath)) {
                // Fallback: scan temp directory for .idx/.sub files that mkvextract may have created with unexpected names
                Logger.WLog(`Expected IDX/SUB not found at ${extractBaseName}. Scanning temp directory for extracted files...`);
                let fallbackFound = false;
                try {
                    let tempFiles = System.IO.Directory.GetFiles(Flow.TempPath);
                    for (let tf of tempFiles) {
                        let tfStr = tf.toString();
                        if (tfStr.endsWith('.idx') && tfStr !== idxFilePath) {
                            let candidateBase = tfStr.substring(0, tfStr.length - 4);
                            let candidateSub = candidateBase + '.sub';
                            if (System.IO.File.Exists(candidateSub)) {
                                Logger.ILog(`Found misplaced extraction: ${tfStr}. Renaming to expected path.`);
                                System.IO.File.Move(tfStr, idxFilePath);
                                System.IO.File.Move(candidateSub, subFilePath);
                                fallbackFound = true;
                                break;
                            }
                        }
                    }
                } catch (scanError) {
                    Logger.WLog(`Fallback scan failed: ${scanError.message || scanError}`);
                }
                if (!fallbackFound) {
                    Logger.ELog(`Extracted IDX/SUB pair for ${extractBaseName} not found. Skipping track.`);
                    continue;
                }
            }
            Logger.ILog(`Extracted ${extractBaseName}.idx and .sub`);

            let streamLangForVobSubTool = VobSubStreamLanguage.trim() || track.language;
            if (streamLangForVobSubTool === "und") streamLangForVobSubTool = "";

            let actualTesseractLang = TesseractOcrLanguage.trim() || streamLangForVobSubTool || "eng";
            if (actualTesseractLang === "und" || actualTesseractLang.trim() === "") actualTesseractLang = "eng";

            let srtFilePathInTemp = convertVobSubToSrt(vobSubBasePathInTemp, streamLangForVobSubTool, actualTesseractLang);

            if (srtFilePathInTemp && System.IO.File.Exists(srtFilePathInTemp)) {
                Logger.ILog(`Temporary SRT created for track ${track.id}: ${srtFilePathInTemp}`);
                srtFilesDataForProcessing.push({
                    srtPath: srtFilePathInTemp,
                    originalTrackData: track,
                    usedVobSubStreamLang: streamLangForVobSubTool,
                    processingIndex: i
                });
            } else {
                Logger.ELog(`Failed to convert VobSub to SRT for track ${track.id} from ${vobSubBasePathInTemp}.idx`);
            }
            try { if (System.IO.File.Exists(idxFilePath)) System.IO.File.Delete(idxFilePath); } catch (e) {}
            try { if (System.IO.File.Exists(subFilePath)) System.IO.File.Delete(subFilePath); } catch (e) {}
        }

        if (srtFilesDataForProcessing.length === 0) {
            Logger.ILog("No SRT files were generated from VobSub tracks for further processing.");
            return finalFilteredTracks.length > 0 ? -1 : 1;
        }

        let finalOutputWorkingFile = workingFile;
        let overallSuccess = false;

        if (MuxToMkv) {
            Logger.ILog(`MuxToMkv is true. Attempting to mux ${srtFilesDataForProcessing.length} SRT(s) into MKV.`);
            let muxedOutputTempMkv = `${Flow.TempPath}/${baseNameForTempFiles}_muxed_vob.mkv`;
            let mkvmergeArgs = ['-o', muxedOutputTempMkv, finalOutputWorkingFile];

            for (let srtData of srtFilesDataForProcessing) {
                let langForMux = srtData.usedVobSubStreamLang || srtData.originalTrackData.language || "eng";
                if (langForMux === "und" || langForMux.trim() === "") langForMux = "eng";

                mkvmergeArgs.push('--language', `0:${langForMux.trim().substring(0,3)}`);
                let srtTrackName = srtData.originalTrackData.trackName ? `${srtData.originalTrackData.trackName} (SRT from VobSub)` : `VobSub Track ${srtData.originalTrackData.id} (SRT)`;
                mkvmergeArgs.push('--track-name', `0:${srtTrackName}`);
                mkvmergeArgs.push('--default-track', '0:no');
                mkvmergeArgs.push('--forced-track', '0:no');
                mkvmergeArgs.push(srtData.srtPath);
            }

            Logger.ILog(`Executing mkvmerge for muxing. Output: ${muxedOutputTempMkv}`);
            let muxResult;
            try {
                muxResult = Flow.Execute({ command: MKVMERGE_EXECUTABLE, argumentList: mkvmergeArgs });
            } catch (e) {
                Logger.ELog(`Failed to execute mkvmerge for muxing: ${e.message || e}`);
                muxResult = { exitCode: -1 };
            }

            if (muxResult.exitCode === 0 && System.IO.File.Exists(muxedOutputTempMkv)) {
                Logger.ILog("Muxing successful. Updating working file.");
                Flow.SetWorkingFile(muxedOutputTempMkv);
                overallSuccess = true;
                if (workingFile !== muxedOutputTempMkv && System.IO.File.Exists(workingFile)) {
                     try { System.IO.File.Delete(workingFile); Logger.ILog(`Deleted original temp MKV: ${workingFile}`);}
                     catch(eDelOrigTemp) { Logger.WLog(`Could not delete original temp MKV ${workingFile}: ${eDelOrigTemp.message}`);}
                }
            } else {
                Logger.ELog(`Mkvmerge for muxing failed. Exit: ${muxResult.exitCode}. Stderr: ${muxResult.standardError || 'N/A'}`);
                Logger.WLog("Falling back to creating external SRT files.");
                if (System.IO.File.Exists(muxedOutputTempMkv)) try {System.IO.File.Delete(muxedOutputTempMkv);}catch(e){}
                overallSuccess = copyVobSubSrtsExternallyAndCleanup(srtFilesDataForProcessing, originalFileNameForOutput) > 0;
                Flow.SetWorkingFile(workingFile);
            }
        } else {
            Logger.ILog("MuxToMkv is false. Creating external SRT files.");
            overallSuccess = copyVobSubSrtsExternallyAndCleanup(srtFilesDataForProcessing, originalFileNameForOutput) > 0;
            Flow.SetWorkingFile(workingFile);
        }

        srtFilesDataForProcessing.forEach(sfd => {
             try { if(System.IO.File.Exists(sfd.srtPath)) System.IO.File.Delete(sfd.srtPath); }
             catch (e) { Logger.WLog(`Final cleanup: Could not delete temp VobSub-SRT: ${sfd.srtPath} - ${e.message}`); }
        });

        return overallSuccess ? 1 : -1;
    }

    function copyVobSubSrtsExternallyAndCleanup(srtFilesDataList, refOriginalFile) {
        let createdCount = 0;
        let origFileDir = refOriginalFile.substring(0, refOriginalFile.lastIndexOf(Flow.IsWindows ? '\\' : '/'));
        let origFileBaseName = refOriginalFile.substring(refOriginalFile.lastIndexOf(Flow.IsWindows ? '\\' : '/') + 1, refOriginalFile.lastIndexOf('.'));

        for (let srtData of srtFilesDataList) {
            let langForSuffix = srtData.usedVobSubStreamLang || srtData.originalTrackData.language;
            if (langForSuffix === "und" || !langForSuffix || langForSuffix.trim() === "") langForSuffix = "";
            else langForSuffix = `.${langForSuffix.trim().substring(0,3)}`;

            let destSrt = `${origFileDir}/${origFileBaseName}${langForSuffix}.${srtData.originalTrackData.id}_${srtData.processingIndex}.vobsub.srt`;

            try {
                System.IO.File.Copy(srtData.srtPath, destSrt, true);
                Logger.ILog(`Copied external SRT to: ${destSrt}`);
                if (!Flow.IsWindows && FilePermissions) {
                    Flow.Execute({ command: "chmod", argumentList: [FilePermissions, destSrt] });
                }
                createdCount++;
            } catch (eCopyExt) {
                Logger.ELog(`Failed to copy external SRT from ${srtData.srtPath} to ${destSrt}: ${eCopyExt.message}`);
            }
            try { if(System.IO.File.Exists(srtData.srtPath)) System.IO.File.Delete(srtData.srtPath); }
            catch (e) { Logger.WLog(`Could not delete temp SRT after VobSub external copy attempt: ${srtData.srtPath} - ${e.message}`); }
        }
        return createdCount;
    }

    function processIdxFile(idxInputPath, originalIdxFileNameRef) {
        Logger.ILog(`Standalone IDX file detected: ${idxInputPath}`);
        let baseNameForSrtAndTool = idxInputPath.substring(idxInputPath.lastIndexOf(Flow.IsWindows ? '\\' : '/') + 1, idxInputPath.lastIndexOf('.'));
        let tempIdxBase = `${Flow.TempPath}/${baseNameForSrtAndTool}`;

        let tempIdxPath = `${tempIdxBase}.idx`;
        let tempSubPath = `${tempIdxBase}.sub`;
        let sourceSubPath = idxInputPath.replace(/\.idx$/i, ".sub");

        try {
            System.IO.File.Copy(idxInputPath, tempIdxPath, true);
            if (System.IO.File.Exists(sourceSubPath)) {
                System.IO.File.Copy(sourceSubPath, tempSubPath, true);
                Logger.ILog(`Copied ${idxInputPath} and ${sourceSubPath} to temp folder for processing.`);
            } else {
                Logger.ELog(`.sub file not found for ${idxInputPath} at expected location ${sourceSubPath}. Conversion cannot proceed.`);
                return -1;
            }
        } catch (eCopyPair) {
            Logger.ELog(`Error copying IDX/SUB pair to temp folder: ${eCopyPair.message}`);
            return -1;
        }
        System.Threading.Thread.Sleep(FileWaitMs);

        let streamLangForVobSubTool = VobSubStreamLanguage.trim() || "";
        let actualTesseractLang = TesseractOcrLanguage.trim() || streamLangForVobSubTool || "eng";
         if (actualTesseractLang === "und" || actualTesseractLang.trim() === "") actualTesseractLang = "eng";

        let srtFilePathInTemp = convertVobSubToSrt(tempIdxBase, streamLangForVobSubTool, actualTesseractLang);

        try { if(System.IO.File.Exists(tempIdxPath)) System.IO.File.Delete(tempIdxPath); } catch(e){}
        try { if(System.IO.File.Exists(tempSubPath)) System.IO.File.Delete(tempSubPath); } catch(e){}

        if (!srtFilePathInTemp || !System.IO.File.Exists(srtFilePathInTemp)) {
            Logger.ELog(`Failed to convert standalone IDX/SUB pair from ${tempIdxBase} to SRT.`);
            return -1;
        }

        Logger.ILog(`SRT file created at: ${srtFilePathInTemp}. Copying to original location...`);
        let origFileDir = originalIdxFileNameRef.substring(0, originalIdxFileNameRef.lastIndexOf(Flow.IsWindows ? '\\' : '/'));
        let origFileBaseName = originalIdxFileNameRef.substring(originalIdxFileNameRef.lastIndexOf(Flow.IsWindows ? '\\' : '/') + 1, originalIdxFileNameRef.lastIndexOf('.'));

        let langSuffixOutput = streamLangForVobSubTool ? `.${streamLangForVobSubTool.substring(0,3)}` : "";
        let destSrt = `${origFileDir}/${origFileBaseName}${langSuffixOutput}.vobsub.srt`;

        try {
            System.IO.File.Copy(srtFilePathInTemp, destSrt, true);
            Logger.ILog(`Copied standalone SRT to: ${destSrt}`);
            if (!Flow.IsWindows && FilePermissions) {
                Flow.Execute({ command: "chmod", argumentList: [FilePermissions, destSrt] });
            }
            Flow.SetWorkingFile(destSrt);
            try { if(System.IO.File.Exists(srtFilePathInTemp)) System.IO.File.Delete(srtFilePathInTemp); } catch(e){}
            return 1;
        } catch (eCopy) {
            Logger.ELog(`Failed to copy standalone SRT from ${srtFilePathInTemp} to ${destSrt}: ${eCopy.message}`);
            try { if(System.IO.File.Exists(srtFilePathInTemp)) System.IO.File.Delete(srtFilePathInTemp); } catch(e){}
            return -1;
        }
    }

    function convertVobSubToSrt(basePathForTool, internalStreamLang, tesseractOcrLangForTool) {
        let srtOutputPath = `${basePathForTool}.srt`;

        let vobsubArgs = [];
        if (DumpImages) vobsubArgs.push("--dump-images");

        let vobSubLangArg = internalStreamLang.trim();
        if (vobSubLangArg && vobSubLangArg !== "und") {
            vobsubArgs.push("--lang", vobSubLangArg.substring(0,2));
            Logger.ILog(`Using --lang ${vobSubLangArg.substring(0,2)} for vobsub2srt.`);
        } else {
            Logger.ILog("No specific internal stream language for vobsub2srt --lang; tool will use its default (likely first stream or all if multi-srt output capable).");
        }

        let tesseractLangForArg = (tesseractOcrLangForTool && tesseractOcrLangForTool.trim() !== "" && tesseractOcrLangForTool !== "und") ? tesseractOcrLangForTool.trim() : "eng";
        if (tesseractLangForArg.length !== 3) { // Common tesseract languages are 3 letters
            Logger.WLog(`Tesseract language '${tesseractLangForArg}' is not a 3-letter code. Defaulting to 'eng'. Ensure this is correct for your Tesseract setup.`);
            tesseractLangForArg = "eng";
        }
        vobsubArgs.push("--tesseract-lang", tesseractLangForArg);
        Logger.ILog(`Using --tesseract-lang ${tesseractLangForArg} for vobsub2srt.`);

        if (Blacklist) vobsubArgs.push("--blacklist", Blacklist);
        // Only add these if they are not their default values, to keep command cleaner
        if (YThreshold !== 0) vobsubArgs.push("--y-threshold", YThreshold.toString());
        if (MinWidth !== 9) vobsubArgs.push("--min-width", MinWidth.toString());
        if (MinHeight !== 1) vobsubArgs.push("--min-height", MinHeight.toString());

        vobsubArgs.push(basePathForTool);

        Logger.ILog(`Executing: ${VOBSUB2SRT_EXECUTABLE} ${vobsubArgs.join(' ')}`);
        let result;
        try {
            result = Flow.Execute({
                command: VOBSUB2SRT_EXECUTABLE,
                argumentList: vobsubArgs
            });
        } catch (e) {
            Logger.ELog(`Failed to execute vobsub2srt: ${e.message || e}`);
            return null;
        }

        Logger.ILog(`vobsub2srt stdout: ${result.output}`);
        Logger.ILog(`vobsub2srt stderr: ${result.standardError || 'N/A'}`);
        Logger.ILog(`vobsub2srt exit code: ${result.exitCode}`);

        System.Threading.Thread.Sleep(FileWaitMs);

        if (result.exitCode === 0 && System.IO.File.Exists(srtOutputPath)) {
            Logger.ILog(`SRT created successfully by vobsub2srt: ${srtOutputPath}`);
            return srtOutputPath;
        } else {
            // Fallback check for language-suffixed files (e.g., base.en.srt)
            if (vobSubLangArg && vobSubLangArg !== "und") {
                let langSuffixSrtPath = `${basePathForTool}.${vobSubLangArg.substring(0,2)}.srt`;
                if (System.IO.File.Exists(langSuffixSrtPath)) {
                    Logger.ILog(`SRT created with language suffix by vobsub2srt: ${langSuffixSrtPath}`);
                    // To keep logic simple downstream, attempt to rename/move it to the expected srtOutputPath
                    try {
                        System.IO.File.Move(langSuffixSrtPath, srtOutputPath, true);
                        Logger.ILog(`Moved ${langSuffixSrtPath} to ${srtOutputPath}`);
                         return srtOutputPath;
                    } catch (eMove) {
                        Logger.WLog(`Found ${langSuffixSrtPath} but failed to move to ${srtOutputPath}: ${eMove.message}. Using lang-specific path as is.`);
                        return langSuffixSrtPath; // Return this one if move fails
                    }
                }
            }
            Logger.ELog(`vobsub2srt failed or SRT file not found at expected path(s). Main path checked: ${srtOutputPath}. Exit: ${result.exitCode}`);
            return null;
        }
    }
}
