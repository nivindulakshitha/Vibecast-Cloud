require("dotenv").config();
const { Storage } = require("@google-cloud/storage");
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');
const { scrapeData } = require('./scrapper');

const project = process.env.PROJECT_ID;
const keyFilename = process.env.KEY_FILE;
const bucketName = process.env.BUCKET_NAME;

async function createVideo(id, startTime, quality) {
    const inputImage = `${id}.png`;
    const inputAudio = `${id}.mp3`;
    const outputVideo = `${id}.mp4`;
    const trimStartTime = startTime;
    const duration = 30;
    const bitrate = quality;

    const command = `ffmpeg -y -loop 1 -i ${inputImage} -ss ${trimStartTime} -i ${inputAudio} -c:v libx264 -c:a aac -strict experimental -b:a 192k -b:v ${bitrate} -pix_fmt yuv420p -vf "scale=1080:1920,setsar=1:1" -t ${duration} ${outputVideo}`;

    const ffmpegProcess = exec(command);

    return ffmpegProcess.on('close', (code) => {
        if (code === 0) {
            uploadFile("rendered/" + outputVideo);
            return getFileAccessUri(outputVideo);
        } else {
            console.error(`\t(FFMPEG) FFmpeg process exited with code ${code}`);
        }
    });
}

async function uploadFile(filepath) {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const bucketName = process.env.BUCKET_NAME;
        const filename = path.basename(filepath);
        await storage.bucket(bucketName).upload(filename, {
            destination: filepath,
        });
        console.log(`\t(FILETRANS) ${filename} uploaded.`);
    } catch (err) {
        console.error("\t(FILETRANS) ", err);
    }
}

async function getFileAccessUri(filename) {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const filePath = `rendered/${filename}`;
        const file = storage.bucket(bucketName).file(filePath);
        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
        });
        console.log(`\t(FILETRANS) URI:`, url);
    } catch (err) {
        console.error("\t(FILETRANS) ERROR:", err);
    }
}

async function watchForNewFiles() {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const [files] = await storage.bucket(bucketName).getFiles({ prefix: 'watch/' });
        if (files.length) {
            console.log('\nNew file(s) found in the "watch" destination:');
            files.forEach(file => {
                file.download().then(contents => {
                    try {
                        const jsonContent = JSON.parse(contents.toString());
                        const sondId = jsonContent.id;
                        
                        if (jsonContent.imageData && jsonContent.startTime && jsonContent.quality) {
                            const base64Data = jsonContent.imageData.replace(/^data:image\/png;base64,/, "");
                            const songUrl = jsonContent.songUrl;
                            const startTime = jsonContent.startTime;
                            const quality = jsonContent.quality;
                            const mp3File = fs.createWriteStream(`${sondId}.mp3`);

                            file.delete().then(() => { console.log(`File ${file.name} deleted.`); }).catch(err => { console.error("ERROR:", err); });

                            fs.writeFile(`${sondId}.png`, base64Data, 'base64', function (err) {
                                if (err) {
                                    console.error("\t(FILEPROC)", err);
                                    return;
                                } else {
                                    console.log(`\t(FILEPROC) Image: ${sondId}.png`);
                                }
                            });

                            https.get(songUrl, function (response) {
                                response.pipe(mp3File);
                                mp3File.on('finish', function () {
                                    mp3File.close();
                                    console.log(`\t(FILEPROC) Song: ${sondId}.mp3`);

                                    createVideo(sondId, startTime, quality).then((uri, error) => {
                                        if (error) {
                                            console.error("\t(FILEPROC)", error);
                                        } else {
                                            console.log(`\t(FILEPROC) Video: ${uri}`);
                                            jsonContent.videoUri = uri;

                                            fs.writeFile(`${jsonContent.id}.json`, JSON.stringify(jsonContent), 'utf8', function (err) {
                                                if (err) {
                                                    console.error("\t(FILEPROC)", err);
                                                } else {
                                                    console.log(`\t(FILEPROC) JSON: ${jsonContent.id}.json`);
                                                    uploadFile(`watch/${jsonContent.id}.json`);
                                                }
                                            });
                                        }
                                    });
                                });
                            }).on('error', function (err) {
                                fs.unlink(`${sondId}.mp3`);
                                console.error("\tERROR:", err.message);
                            });
                        } else if (jsonContent.spotifyUrl && jsonContent.songUrl === undefined) {
                            const spotifyUrl = jsonContent.spotifyUrl;

                            file.delete().then(() => { console.log(`\t(Scrape) File ${file.name} deleted.`); }).catch(err => { console.error("ERROR:", err); });

                            scrapeData(spotifyUrl).then((downloadUrl, error) => {
                                if (error || !downloadUrl) {
                                    jsonContent.songUrl = false;
                                } else {
                                    jsonContent.songUrl = downloadUrl;
                                }

                                fs.writeFile(`${jsonContent.id}.json`, JSON.stringify(jsonContent), 'utf8', function (err) {
                                    if (err) {
                                        console.error("\tERROR:", err);
                                    } else {
                                        console.log(`\t(Scrape) JSON: ${jsonContent.id}.json`);
                                        uploadFile(`watch/${jsonContent.id}.json`);
                                    }
                                });
                            });
                        } else {
                            console.error("\tNo image data or song URL is processed already. Skipping...");
                        }
                    } catch (err) {
                        console.error("ERROR:", err);
                    }
                });
            });
        }
    } catch (err) {
        console.error("ERROR:", err);
    }
}

async function deleteOldFiles() {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const [files] = await storage.bucket(bucketName).getFiles();
        const currentTime = Date.now();

        files.forEach(async (file) => {
            const [metadata] = await file.getMetadata();
            const lastModifiedTime = new Date(metadata.updated).getTime();

            if (currentTime - lastModifiedTime > 15 * 60 * 1000) {
                await file.delete();
                console.log(`\t(FILETRANS) ${file.name} deleted.`);
            }
        });
    } catch (err) {
        console.error("\t(FILETRANS) ERROR:", err);
    }
}

const watchInterval = 5000;
setInterval(deleteOldFiles, 15 * 60 * 1000); // Delete files older than 15 minutes
setInterval(watchForNewFiles, watchInterval); // Check for new files every 5 seconds