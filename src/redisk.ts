import { Type } from './metadata/type';
import { Metadata } from './metadata/metadata';
import { PropertyMetadata } from './metadata/property.metadata';
import { Condition } from './interfaces/condition';
import { OrderBy } from './interfaces/orderby';
import { ClientOptions, Client, RedisClient } from './client';

export class Redisk {

    constructor(
        private readonly metadata: Metadata,
        private readonly client: Client,
    ) {
    }

    static init(options: ClientOptions) {
        return new Redisk(new Metadata(), new RedisClient(options));
    }

    async close() {
        await this.client.closeConnection();
    }

    getClient(): Client {
        return this.client;
    }

    async save<T>(entity: T): Promise<void> {

        const {name, uniques, primary, canBeListed, indexes, properties, hasOneRelations} = this.metadata.getEntityMetadataFromInstance(entity);

        const hashKey = name + ':' + entity[primary];

        const persistedEntity = await this.getOne<T>(entity.constructor as Type<T>, entity[primary]);
        if (persistedEntity !== null) {
            const changedFields = [];

            for (const property of properties) {
                if (entity[property.name] !== persistedEntity[property.name]) {
                    changedFields.push(property.name);

                    if (entity[property.name] === null) {
                        await this.client.hdel(hashKey, property.name);
                    }

                    if (hasOneRelations !== undefined && hasOneRelations[property.name] && hasOneRelations[property.name].cascadeUpdate && entity[property.name] !== null) {
                        await this.save(entity[property.name]);
                    }

                    if (property.searchable) {
                        await this.client.srem(
                            this.getSearchableKeyName(name, property.name),
                            this.getSearchableValuePrefix(entity[primary]) + persistedEntity[property.name].toLowerCase(),
                        );
                    }
                    if (property.sortable) {
                        await this.client.zrem(this.getSortableKeyName(name, property.name), persistedEntity[property.name]);
                    }
                }
            }

            if (indexes) {
                const indexesChanged = changedFields.some(value => indexes.indexOf(value) >= 0);
                if (indexesChanged) {
                    await this.dropIndexes(persistedEntity, entity[primary]);
                }
            }

            if (uniques) {
                const uniquesChanged = changedFields.some(value => uniques.indexOf(value) >= 0);
                if (uniquesChanged) {
                    await this.dropUniqueKeys(persistedEntity);
                }
            }

        }

        if (uniques) {
            for (const uniqueName of uniques) {
                const entityWithUnique = await this.getOne<T>(entity.constructor as Type<T>, entity[uniqueName], uniqueName);
                if (entityWithUnique !== null && entityWithUnique[primary] !== entity[primary]) {
                    throw new Error(uniqueName + ' is not unique!');
                }
                if (entity[uniqueName] !== null) {
                    await this.client.set(
                        this.getUniqueKeyName(name, uniqueName) + ':' + entity[uniqueName],
                        entity[primary],
                    );
                }
            }
        }

        const valuesToStore = [];
        for (const property of properties) {
            if (entity[property.name] !== null) {

                let valueToStore = this.convertPropertyTypeToPrimitive(property, entity[property.name]);

                if (hasOneRelations !== undefined && hasOneRelations[property.name]) {
                    const relatedEntity = this.metadata.getEntityMetadataFromName(hasOneRelations[property.name].entity);
                    valueToStore = entity[property.name][relatedEntity.primary];

                    if (hasOneRelations[property.name].cascadeInsert && persistedEntity === null && entity[property.name] !== null) {
                        await this.save(entity[property.name]);
                    }
                }

                valuesToStore.push(property.name);
                valuesToStore.push(valueToStore);

                if (property.sortable === true) {
                    await this.client.zadd(
                        this.getSortableKeyName(name, property.name),
                        this.convertPropertyTypeToPrimitive(property, entity[property.name]),
                        entity[primary],
                    );
                }

                if (property.searchable === true) {
                    await this.client.sadd(
                        this.getSearchableKeyName(name, property.name),
                        this.getSearchableValuePrefix(entity[primary]) + entity[property.name].toLowerCase(),
                    );
                }
            }
        }
        await this.client.hmset(hashKey, valuesToStore);

        if (indexes) {
            for (const indexName of indexes) {
                let value = entity[indexName];
                if (hasOneRelations !== undefined && hasOneRelations[indexName] && entity[indexName] !== null) {
                    const relatedEntity = this.metadata.getEntityMetadataFromName(hasOneRelations[indexName].entity);
                    value = entity[indexName][relatedEntity.primary];
                }
                if (value !== null) {
                    await this.client.sadd(this.getIndexKeyName(name, indexName, value), entity[primary]);
                }
            }
        }

        if (canBeListed && persistedEntity === null) {
            await this.client.rpush(this.getListKeyName(name), entity[primary]);
        }

        return null;
    }

    async count<T>(entityType: Type<T>): Promise<number> {
        const { name } = this.metadata.getEntityMetadataFromType(entityType);
        const keyName = this.getListKeyName(name);

        return await this.client.llen(keyName);
    }

    async list<T>(entityType: Type<T>, limit?: number, offset?: number, orderBy?: OrderBy): Promise<T[]> {
        const ids = await this.listIds(entityType, limit, offset, orderBy);
        const response = [];

        for (const id of ids) {
            response.push(await this.getOne(entityType, id));
        }

        return response;
    }

    async find<T>(
        entityType: Type<T>,
        conditions: Condition[],
        limit?: number,
        offset?: number,
        type: 'AND' | 'OR' = 'AND',
    ): Promise<T[]> {
        const ids = await this.findIds(entityType, conditions, type);
        const response = [];

        if (limit !== undefined || offset !== undefined) {
            if (limit === undefined || offset === undefined) {
                throw new Error('You must specify limit and offset, not just one arg.');
            }
            for (let index = offset; index < ids.length && index < (limit + offset); index++) {
                response.push(await this.getOne(entityType, ids[index]));
            }
        } else {
            for (const id of ids) {
                response.push(await this.getOne(entityType, id));
            }
        }

        return response;
    }

    async search<T>(entityType: Type<T>, condition: Condition, limit: number): Promise<T[]> {
        const ids = await this.searchIds(entityType, condition, limit);
        const response = [];

        const numberOfResult = (ids.length < limit) ? ids.length : limit;
        for (let index = 0; index < numberOfResult; index++) {
            response.push(await this.getOne(entityType, ids[index]));
        }

        return response;
    }

    async searchIds<T>(entityType: Type<T>, condition: Condition, limit: number): Promise<string[]> {
        const { name } = this.metadata.getEntityMetadataFromType(entityType);

        const key = this.getSearchableKeyName(name, condition.key);
        const value = this.getSearchableValuePrefix('*') + '*' + condition.value.toLowerCase() + '*';

        const response: string[] = [];

        let finishedScanning = false;
        let cursor = 0;
        while (!finishedScanning) {
            const scanResponse = (await this.client.sscan(key, cursor, value));
            cursor = scanResponse.cursor;

            response.push(
                ...scanResponse.data.map((id: string) => id.match(/.+?(?=\:_id_:)/g)[0]),
            );

            if (cursor === 0 || response.length === limit) {
                finishedScanning = true;
            }
        }

        return response;
    }

    async findIds<T>(entityType: Type<T>, conditions: Condition[], type: 'AND' | 'OR' = 'AND'): Promise<string[]> {

        if (conditions.length === 0) {
            throw new Error('You should at least specify one key to search');
        }

        const { name } = this.metadata.getEntityMetadataFromType(entityType);

        const keyNames: string[] = [];

        for (const condition of conditions) {
            keyNames.push(this.getIndexKeyName(name, condition.key, String(condition.value)));
        }

        if (type === 'AND') {
            return await this.client.sinter(keyNames);
        } else {
            return await this.client.sunion(keyNames);
        }

    }

    async listIds<T>(entityType: Type<T>, limit?: number, offset?: number, orderBy?: OrderBy): Promise<string[]> {
        const { name, canBeListed } = this.metadata.getEntityMetadataFromType(entityType);
        if (!canBeListed) {
            throw new Error(entityType.name + ' can\'t be listed!');
        }

        const keyName = this.getListKeyName(name);

        let start = 0;
        let stop = -1;

        if (offset !== undefined) {
            start = offset;
        }

        if (limit !== undefined) {
            stop = start + limit - 1;
        }

        if (orderBy !== undefined) {
            const sortableKey = this.getSortableKeyName(name, orderBy.field);
            

            if (orderBy.strategy === 'ASC') {
                return await this.client.zrange(sortableKey, start, stop);
            } else {
                return await this.client.zrevrange(sortableKey, start, stop);
            }
        }

        return await this.client.lrange(keyName, start, stop);
    }

    async delete<T>(entityType: Type<T>, id: string): Promise<void> {
        const { name, uniques, indexes, canBeListed } = this.metadata.getEntityMetadataFromType(entityType);
        const hashKey = name + ':' + id;

        const persistedEntity = await this.getOne(entityType, id);
        if (uniques) {
            await this.dropUniqueKeys(persistedEntity);
        }
        if (indexes) {
            await this.dropIndexes(persistedEntity, id);
        }

        if (canBeListed) {
            await this.client.lrem(this.getListKeyName(name), 1, id);
        }

        await this.dropSortables(persistedEntity);
        await this.dropSearchables(persistedEntity);

        await this.client.del(hashKey);
    }

    async getOne<T>(entityType: Type<T>, value: any, key?: string): Promise<T> {
        const entity = Object.create(entityType.prototype);
        const valueAsString = String(value);
        const { name, uniques, primary, properties, hasOneRelations } = this.metadata.getEntityMetadataFromType(entityType);

        // Search for indexes
        let id: string;
        if (key !== undefined && key !== primary) {
            let indexKey;
            for (const uniqueName of uniques) {
                if (uniqueName === key) {
                    indexKey = this.getUniqueKeyName(name, uniqueName);
                }
            }
            if (indexKey === undefined) {
                throw new Error(key + ' is not an unique field!');
            }
            id = await this.client.get(indexKey + ':' + valueAsString);
        } else {
            id = valueAsString;
        }

        const hashKey = name + ':' + id;

        const result = await this.client.hmget(hashKey, properties.map((property: PropertyMetadata) => property.name));
        let index = 0;
        for (const resultKey of result) {
            if (hasOneRelations !== undefined && hasOneRelations[properties[index].name] && resultKey !== null) {
                entity[properties[index].name] = await this.getOne(hasOneRelations[properties[index].name].entityType as any, resultKey);
            } else {
                entity[properties[index].name] = this.convertStringToPropertyType(properties[index], resultKey);
            }
            index++;
        }
        if (entity[primary] === null) {
            return null;
        }
        return entity;
    }

    private convertPropertyTypeToPrimitive(property: PropertyMetadata, value: any): any {
        if (property.type === 'Date') {
            return value.valueOf();
        }
        return String(value);
    }

    private convertStringToPropertyType(property: PropertyMetadata, value: string): any {
        let convertedValue: any = value;

        switch (property.type) {
            case 'Boolean':
                convertedValue = value === 'true';
                break;
            case 'Number':
                convertedValue = Number(value);
                break;
            case 'Date':
                convertedValue = new Date(Number(value));
                break;
        }

        return convertedValue;
    }

    private async dropUniqueKeys<T>(entity: T): Promise<void> {
        const { name, uniques } = this.metadata.getEntityMetadataFromInstance(entity);
        for (const uniqueName of uniques) {
            await this.client.del(this.getUniqueKeyName(name, uniqueName) + ':' + entity[uniqueName]);
        }
    }

    private async dropIndexes<T>(entity: T, id: string): Promise<void> {
        const { name, indexes, hasOneRelations } = this.metadata.getEntityMetadataFromInstance(entity);
        if (indexes) {
            for (const indexName of indexes) {
                let value = entity[indexName];
                if (hasOneRelations !== undefined && hasOneRelations[indexName]) {
                    const relatedEntity = this.metadata.getEntityMetadataFromName(hasOneRelations[indexName].entity);
                    value = entity[indexName][relatedEntity.primary];
                }
                await this.client.srem(this.getIndexKeyName(name, indexName, value), id);
            }
        }
    }

    private async dropSearchables<T>(entity: T): Promise<void> {
        const { name, properties, primary } = this.metadata.getEntityMetadataFromInstance(entity);
        for (const property of properties) {
            if (property.searchable === true) {
                await this.client.srem(
                    this.getSearchableKeyName(name, property.name),
                    this.getSearchableValuePrefix(entity[primary]) + entity[property.name].toLowerCase(),
                );
            }
        }
    }

    private async dropSortables<T>(entity: T): Promise<void> {
        const { name, properties, primary } = this.metadata.getEntityMetadataFromInstance(entity);
        for (const property of properties) {
            if (property.sortable === true) {
                await this.client.zrem(
                    this.getSortableKeyName(name, property.name),
                    entity[primary],
                );
            }
        }
    }

    private getIndexKeyName(entityName: string, indexName: string, indexValue: string): string {
        return entityName + ':index:' + indexName + ':' + indexValue;
    }

    private getListKeyName(entityName: string): string {
        return entityName + ':list';
    }

    private getUniqueKeyName(entityName: string, uniqueName: string): string {
        return entityName + ':unique:' + uniqueName;
    }

    private getSortableKeyName(entityName: string, fieldName: string): string {
        return entityName + ':sort:' + fieldName;
    }

    private getSearchableKeyName(entityName: string, fieldName: string): string {
        return entityName + ':search:' + fieldName;
    }

    private getSearchableValuePrefix(id: string): string {
        return id + ':_id_:';
    }

}
