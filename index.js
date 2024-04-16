require("dotenv").config();
const { Storage } = require("@google-cloud/storage");
const path = require('path');
const fs = require('fs');
const https = require('https');
const { scrapeData } = require('./scrapper');
const moment = require('moment-timezone');

const project = process.env.PROJECT_ID;
const keyFilename = process.env.KEY_FILE;
const bucketName = process.env.BUCKET_NAME;

const { spawn } = require('child_process');

async function createVideo(id, startTime, quality) {
    const inputImage = `${id}.png`;
    const inputAudio = `${id}.mp3`;
    const outputVideo = `${id}.mp4`;
    const trimStartTime = startTime;
    const duration = 30;
    const bitrate = quality;

    const command = `ffmpeg -y -loop 1 -i ${inputImage} -ss ${trimStartTime} -i ${inputAudio} -c:v libx264 -c:a aac -strict experimental -b:a 192k -b:v ${bitrate} -pix_fmt yuv420p -vf "scale=1080:1920,setsar=1:1" -t ${duration} ${outputVideo}`;
    const ffmpegProcess = spawn(command, { shell: true });

    ffmpegProcess.stdout.on('data', (data) => {
        console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpegProcess.on('error', async (error) => {
        console.error(`FFmpeg error: ${error.message}`);
        reject(`FFmpeg process exited with error ${error.message}`);
        unlinkFile(inputImage);
        unlinkFile(inputAudio);
    });

    return new Promise((resolve, reject) => {
        ffmpegProcess.on('close', async (code) => {
            if (code === 0) {
                console.log('FFmpeg process completed successfully');
                await uploadFile("rendered/" + outputVideo);
                unlinkFile(outputVideo);
                resolve(getFileAccessUri("rendered/" + outputVideo));
            } else {
                console.error(`\t(FFMPEG) FFmpeg process exited with code ${code}`);
                reject(`FFmpeg process exited with code ${code}`);
            }

            unlinkFile(inputImage);
            unlinkFile(inputAudio);
        });
    });
}


async function uploadFile(filepath) {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const bucketName = process.env.BUCKET_NAME;
        const filename = path.basename(filepath);

        // Calculate uploaded time with Sri Jayewardenepura timezone (Asia/Colombo)
        const uploadedTime = moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');

        const options = {
            destination: filepath,
            metadata: {
                metadata: {
                    uploadedTime: uploadedTime // Include the uploaded time with the specific timezone offset
                }
            }
        };

        await storage.bucket(bucketName).upload(filename, options);
        console.log(`\t(FILETRANS) ${filename} uploaded.`);
    } catch (err) {
        console.error("\t(FILETRANS) ", err);
    }
}

async function getFileAccessUri(filePath) {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const file = storage.bucket(bucketName).file(filePath);
        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000,
        });
        return url;
    } catch (err) {
        console.error("\t(FILETRANS) ERROR:", err);
        return false;
    }
}

async function watchForNewFiles() {
    try {
        const storage = new Storage({ projectId: project, keyFilename: keyFilename });
        const [files] = await storage.bucket(bucketName).getFiles({ prefix: 'watch/' });
        if (files.length) {
            files.forEach(file => {
                file.download().then(contents => {
                    try {
                        const jsonContent = JSON.parse(contents.toString());
                        const sondId = jsonContent.id;

                        if (jsonContent.imageData && jsonContent.startTime && jsonContent.quality && jsonContent.songUrl && jsonContent.videoUri === undefined) {
                            file.delete().then(() => { console.log(`File ${file.name} deleted.`); }).catch(err => { console.error("ERROR:", err); });

                            const base64Data = jsonContent.imageData.replace(/^data:image\/png;base64,/, "");
                            const songUrl = jsonContent.songUrl;
                            const startTime = jsonContent.startTime;
                            const quality = jsonContent.quality;
                            const mp3File = fs.createWriteStream(`${sondId}.mp3`);

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
                                            jsonContent.videoUri = false;

                                            fs.writeFile(`${jsonContent.id}.json`, JSON.stringify(jsonContent), 'utf8', async function (err) {
                                                if (err) {
                                                    console.error("\t(FILEPROC)", err);
                                                } else {
                                                    await uploadFile(`watch/${jsonContent.id}.json`);
                                                    unlinkFile(`${jsonContent.id}.json`);
                                                }
                                            });
                                        } else {
                                            console.log(`\t(FILEPROC) Video: ${uri}`);
                                            jsonContent.videoUri = uri;

                                            fs.writeFile(`${jsonContent.id}.json`, JSON.stringify(jsonContent), 'utf8', async function (err) {
                                                if (err) {
                                                    console.error("\t(FILEPROC)", err);
                                                } else {
                                                    await uploadFile(`watch/${jsonContent.id}.json`);
                                                    unlinkFile(`${jsonContent.id}.json`);
                                                }
                                            });
                                        }
                                    });
                                });
                            }).on('error', function (err) {
                                unlinkFile(`${sondId}.mp3`)
                                console.error("\tERROR:", err.message);
                            });
                        } else if (jsonContent.spotifyUrl && jsonContent.songUrl === undefined) {
                            file.delete().then(() => { console.log(`File ${file.name} deleted.`); }).catch(err => { console.error("ERROR:", err); });

                            const spotifyUrl = jsonContent.spotifyUrl;
                            console.log(`\t(Scrape) Processing audio...`);
                            scrapeWithRetry(sondId, spotifyUrl)
                                .then(async (savedFile) => {
                                    await uploadFile(`room/${savedFile}`).then(async (res, error) => {
                                        if (error) {
                                            console.error("\t(FILETRANS)", error);
                                        } else {
                                            unlinkFile(savedFile);

                                            await getFileAccessUri(`room/${savedFile}`).then((uri, error) => {
                                                if (error || !uri) {
                                                    console.error("\t(FILETRANS)", error);
                                                } else {
                                                    jsonContent.songUrl = uri;
                                                    jsonContent.quality = "500k"; // remove this line if you want to keep the quality as it is
                                                }
                                            });
                                        }
                                    });
                                })
                                .catch((error) => {
                                    jsonContent.songUrl = false;
                                }).finally(() => {
                                    fs.writeFile(`${jsonContent.id}.json`, JSON.stringify(jsonContent), 'utf8', function (err) {
                                        if (err) {
                                            console.error("\tERROR:", err);
                                        } else {
                                            console.log(`\t(Scrape) JSON: ${jsonContent.id}.json`);
                                            uploadFile(`watch/${jsonContent.id}.json`).then(() => {
                                                unlinkFile(`${jsonContent.id}.json`);
                                            });
                                        }
                                    });
                                });
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

function scrapeWithRetry(songId, spotifyUrl, retryCount = 2) {
    return new Promise(async (resolve, reject) => {
        try {
            const savedFile = await scrapeData(songId, spotifyUrl);
            if (savedFile) {
                resolve(savedFile);
            } else {
                if (retryCount > 0) {
                    console.log(`Retrying scrapeData. Retries left: ${retryCount}`);
                    // Retry with reduced retryCount
                    resolve(await scrapeWithRetry(songId, spotifyUrl, retryCount - 1));
                } else {
                    reject("Maximum retry count reached");
                }
            }
        } catch (error) {
            reject(error);
        }
    });
}

async function deleteOldFiles() {
    const storage = new Storage({ projectId: project, keyFilename: keyFilename });
    const bucketName = process.env.BUCKET_NAME;

    try {
        const [files] = await storage.bucket(bucketName).getFiles();
        const thirtyMinutesAgo = moment().tz('Asia/Colombo').subtract(3, 'minutes');

        for (const file of files) {
            const [metadata] = await file.getMetadata();
            const uploadedTime = moment(metadata.metadata.uploadedTime, 'YYYY-MM-DD HH:mm:ss', true).tz('Asia/Colombo');

            if (uploadedTime.isBefore(thirtyMinutesAgo)) {
                await file.delete();
                console.log(`File ${file.name} deleted.`);
            }
        }
    } catch (err) {
        console.error("Error deleting files:", err);
    }
}

function unlinkFile(filePath) {
    fs.unlink(filePath, function (err) {
        if (err) {
            console.error("\tERROR:", err);
        } else {
            console.log(`\t${filePath} removed locally.`);
        }
    });
}

const watchInterval = 5000;
setInterval(deleteOldFiles, 60000); // Check for old files every 1 minute
//setInterval(watchForNewFiles, watchInterval); // Check for new files every 5 seconds
//uploadFile("watch/0Ryd8975WihbObpp5cPW1t.json");
//uploadFile("watch/6Im9k8u9iIzKMrmV7BWtlF.json");