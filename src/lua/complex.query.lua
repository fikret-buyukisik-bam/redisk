local logtable = {}

local function logit(msg)
  logtable[#logtable+1] = msg
end

local function tableKeysToArray(table)
    local array = {}
    for key, val in pairs(table) do
        array[ #array + 1 ] = key
    end
    return array
end

local function convertToTable(array)
    local table = {}
    for i, val in ipairs(array) do
        table[val] = true
    end
    return table
end

local function tableConcat(t1,t2)
    local t3 = {}

    for key, value in pairs(t1) do
        t3[key] = true
    end

    for key, value in pairs(t2) do
        t3[key] = true
    end
    return t3
end

local function tableWithSameValues(t1, t2)
    local t3 = {}
    for key, value in pairs(t1) do
        if t2[key] == true then
            t3[key] = true
        end
    end
    return t3
end

local function tableDiffs(t1, t2)
    for key, value in pairs(t1) do
        if t2[value] == nil then
            t1[key] = nil
        end
    end
    return t1
end

local function intersect(type, ids, newIds)
    if next(ids) == nil then
        return newIds;
    end
    if type == 'OR' then
        return tableConcat(ids, newIds)
    else
        return tableWithSameValues(ids, newIds)
    end
end

local function extractWithLimitAndOffset(array, limit, offset)
    local filtered = {}
    local max = #array
    if limit ~= -1 then
        max = limit
    end
    for i = offset + 1, max, 1 do
        filtered[#filtered + 1] = array[i]
    end
    return filtered
end

local request = cjson.decode(ARGV[1])

logit(cjson.encode(request))

local ids = {}

if request.orderBy then
    if request.orderBy.strategy == "DESC" then
        ids = redis.call("ZREVRANGEBYSCORE", request.prefix .. request.orderBy.name, request.orderBy.max, request.orderBy.min, "LIMIT", 0, -1)
    else
        ids = redis.call("ZRANGEBYSCORE", request.prefix .. request.orderBy.name, request.orderBy.min, request.orderBy.max, "LIMIT", 0, -1)
    end
    ids = convertToTable(ids)
end

for key,value in ipairs(request.scores) do
    local tempIds = redis.call("ZRANGEBYSCORE", request.prefix .. value.key, value.min, value.max, "LIMIT", 0, -1)
    ids = intersect(request.type, ids, convertToTable(tempIds))
end

for key,value in ipairs(request.equals) do
    local tempIds = redis.call("ZRANGEBYSCORE", request.prefix .. value.key .. ":" .. value.value, "-inf", "+inf", "LIMIT", 0, -1)
    ids = intersect(request.type, ids, convertToTable(tempIds))
end
logit(cjson.encode(ids))

--return logtable
return extractWithLimitAndOffset(tableKeysToArray(ids), request.limit, request.offset)
