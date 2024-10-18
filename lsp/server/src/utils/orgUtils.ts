/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

import {
    AuthInfo,
    ConfigAggregator,
    Connection,
    OrgConfigProperties,
    StateAggregator
} from '@salesforce/core';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceUtils } from './workspaceUtils';
import { ObjectInfoRepresentation } from '../types';

export interface SObject {
    apiName: string;
    label: string;
    labelPlural: string;
}

enum ConnectionStatus {
    UNKNOWN,
    CONNECTED,
    DISCONNECTED
}

export interface Field {
    apiName: string;
    label: string;
    type: string;
}

export class OrgUtils {
    public static orgName: string = '';
    public static objectInfoFolder = 'objectInfos';
    public static entityListFileName = 'entity_list.json';
    public static connection: Connection | undefined;

    private static connectStatus: ConnectionStatus = ConnectionStatus.UNKNOWN;

    static objectInfoInMemoCache = new Map<string, ObjectInfoRepresentation>();
    static objectInfoPromises = new Map<
        string,
        Promise<ObjectInfoRepresentation | undefined>
    >();
    public static entities: string[] = [];

    static sfdxFolder = '.sfdx';
    /**
     * The global folder in which sf state is stored.
     */
    static sfFolder = '.sf';

    static get SFDX_DIR() {
        return path.join(os.homedir(), this.sfdxFolder);
    }
    /**
     * The full system path to the global sf state folder.
     */
    static get SF_DIR() {
        return path.join(os.homedir(), this.sfFolder);
    }

    // Retrieves default organiztion's name.
    public static async getDefaultOrg(): Promise<string> {
        const aggregator = await ConfigAggregator.create();

        await aggregator.reload();

        const currentUserConfig = aggregator.getInfo(
            OrgConfigProperties.TARGET_ORG
        );

        if (currentUserConfig.value) {
            this.orgName = currentUserConfig.value.toString();
            return Promise.resolve(this.orgName);
        }
        return Promise.reject('no org');
    }

    private static onAuthOrgChanged() {
        this.connectStatus = ConnectionStatus.UNKNOWN;
        this.clearCache();
    }

    public static watchConfig() {
        fs.watch(this.SFDX_DIR, (eventType, fileName) => {
            this.onAuthOrgChanged();
        });
        fs.watch(this.SF_DIR, (eventType, fileName) => {
            this.onAuthOrgChanged();
        });
    }

    public static async getDefaultUserName(): Promise<string | undefined> {
        try {
            const orgName = await this.getDefaultOrg();
            const aggregator = await StateAggregator.getInstance();
            const username = aggregator.aliases.getUsername(orgName);
            if (username !== null && username !== undefined) {
                return Promise.resolve(username);
            }
        } catch (error) {
            return undefined;
        }
    }

    // Updates the auth state async
    public static async checkAuthStatus(): Promise<ConnectionStatus> {
        if (this.connectStatus !== ConnectionStatus.UNKNOWN) {
            return this.connectStatus;
        }
        const connection = await this.getConnection();
        if (connection === undefined) {
            this.connectStatus = ConnectionStatus.DISCONNECTED;
        } else {
            this.connectStatus = ConnectionStatus.CONNECTED;
            // Fetches entity list once.
            const entityListFile = path.posix.join(
                this.objectInfoFolderPath(),
                this.entityListFileName
            );
            if (!fs.existsSync(entityListFile)) {
                const objectList = await this.getEntityList(this.connection!!);
                this.entities = objectList;
                fs.writeFileSync(entityListFile, JSON.stringify(objectList), {
                    mode: 0o666
                });
            } else {
                const entityContent = fs.readFileSync(entityListFile, 'utf8');
                this.entities = JSON.parse(entityContent);
            }
        }

        return this.connectStatus;
    }

    // Retrieves the Connection which fetches ObjectInfo remotely.
    public static async getConnection(): Promise<Connection | undefined> {
        if (
            this.connection !== undefined &&
            this.connection.getUsername() !== undefined
        ) {
            return this.connection;
        }
        try {
            const username = await this.getDefaultUserName();
            if (username === undefined) {
                return undefined;
            }
            const connect = await Connection.create({
                authInfo: await AuthInfo.create({ username })
            });
            if (connect !== undefined && connect.getUsername() !== undefined) {
                this.connection = connect;
            }

            return connect;
        } catch (error) {
            this.connection = undefined;
            return undefined;
        }
    }

    public static async getEntityList(
        connection: Connection
    ): Promise<string[]> {
        const globalResult = await connection.describeGlobal();
        return globalResult.sobjects.map((sobjettResult) => sobjettResult.name);
    }

    // Retrieves objectInfo folder path, which is '<projectRoot>/.sf/orgName/objectInfos/'
    public static objectInfoFolderPath(): string {
        const projectPath = WorkspaceUtils.getWorkspaceDir();
        const objectInfoFolder = path.posix.join(
            projectPath,
            this.sfFolder,
            this.orgName,
            OrgUtils.objectInfoFolder
        );
        if (!fs.existsSync(objectInfoFolder)) {
            fs.mkdirSync(objectInfoFolder, { recursive: true });
        }
        return objectInfoFolder;
    }

    public static fetchObjectInfoFromDisk(
        objectApiName: string
    ): ObjectInfoRepresentation | undefined {
        const objectInfoJsonFile = path.posix.join(
            this.objectInfoFolderPath(),
            `${objectApiName}.json`
        );
        if (!fs.existsSync(objectInfoJsonFile)) {
            return undefined;
        }

        const objectInfoStr = fs.readFileSync(objectInfoJsonFile, 'utf-8');
        return JSON.parse(objectInfoStr) as ObjectInfoRepresentation;
    }

    public static getObjectInfoFromCache(
        objectApiName: string
    ): ObjectInfoRepresentation | undefined {
        // Checks mem cache
        let objectInfo = this.objectInfoInMemoCache.get(objectApiName);

        if (objectInfo !== undefined) {
            return objectInfo;
        }

        // Checks disk cache
        objectInfo = this.fetchObjectInfoFromDisk(objectApiName);
        if (objectInfo !== undefined) {
            this.objectInfoInMemoCache.set(objectApiName, objectInfo);
            return objectInfo;
        }
        return undefined;
    }

    // Acquires ObjectInfo data by first searching in memory, then on disk, and finally over the network.
    public static async getObjectInfo(
        objectApiName: string
    ): Promise<ObjectInfoRepresentation | undefined> {
        const connectStatus = await OrgUtils.checkAuthStatus();
        if (connectStatus !== ConnectionStatus.CONNECTED) {
            return undefined;
        }

        const objectInfo = this.getObjectInfoFromCache(objectApiName);
        if (objectInfo !== undefined) {
            return objectInfo;
        }

        // Network loading is going on
        let objectInfoNetworkReponsePromise =
            this.objectInfoPromises.get(objectApiName);
        if (objectInfoNetworkReponsePromise === undefined) {
            objectInfoNetworkReponsePromise = new Promise<
                ObjectInfoRepresentation | undefined
            >(async (resolve) => {
                try {
                    const connection = await OrgUtils.getConnection();
                    if (
                        connection !== undefined &&
                        OrgUtils.entities.indexOf(objectApiName) >= 0
                    ) {
                        const objectInfo = (await connection.request(
                            `${connection.baseUrl()}/ui-api/object-info/${objectApiName}`
                        )) as ObjectInfoRepresentation;

                        if (objectInfo !== undefined) {
                            this.objectInfoResponseCallback(
                                objectApiName,
                                objectInfo
                            );
                        }
                        return resolve(objectInfo);
                    }
                } catch (e) {
                    return resolve(undefined);
                }
            }).finally(() => {
                this.objectInfoPromises.delete(objectApiName);
            });
            this.objectInfoPromises.set(
                objectApiName,
                objectInfoNetworkReponsePromise
            );
        }
        return objectInfoNetworkReponsePromise;
    }

    private static objectInfoResponseCallback(
        objectApiName: string,
        objectInfo: ObjectInfoRepresentation
    ) {
        this.objectInfoInMemoCache.set(objectApiName, objectInfo);
        const objectInfoStr = JSON.stringify(objectInfo);
        const objectInfoFile = path.posix.join(
            this.objectInfoFolderPath(),
            `${objectApiName}.json`
        );
        if (fs.existsSync(objectInfoFile)) {
            fs.unlinkSync(objectInfoFile);
        }

        fs.writeFileSync(objectInfoFile, objectInfoStr, { mode: 0o666 });
    }

    private static clearCache() {
        this.entities.splice(0, this.entities.length);
        this.objectInfoInMemoCache.clear();
        this.objectInfoPromises.clear();
        this.connection = undefined;
        if (this.orgName.length > 0) {
            fs.rmdirSync(this.objectInfoFolderPath(), {
                recursive: true,
                maxRetries: 3
            });
            this.orgName = '';
        }
    }
    public static async getSobjects(): Promise<SObject[]> {
        try {
            const conn = await this.getConnection();
            if (conn === undefined) {
                return [];
            }
            const result = await conn.describeGlobal();

            const sobjects = result.sobjects
                .map((sobject) => {
                    const so: SObject = {
                        apiName: sobject.name,
                        label: sobject.label,
                        labelPlural: sobject.labelPlural
                    };
                    return so;
                })
                .sort((a, b) => a.apiName.localeCompare(b.apiName));
            return Promise.resolve(sobjects);
        } catch (error) {
            console.log(error);
            return Promise.reject(error);
        }
    }
}
